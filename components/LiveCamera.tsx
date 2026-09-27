"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/client";
import { blobToDataUrl, createDetector } from "@/lib/detector-client";
import { PhoneCamera } from "@/components/PhoneCamera";
import { SAMPLING, frameDiff, shouldAnalyze } from "@/lib/sampling";
import type { BBox, Detection, Proposal, TrackedDetection, Zone } from "@/lib/types";
import { DEFAULT_ZONES } from "@/lib/zones";

export interface CameraStatus {
  state: "off" | "starting" | "live" | "denied" | "none" | "error";
  label?: string;
  resolution?: string;
  cameraFps?: number;
  analysisFps: number;
  visionLatency?: number;
  visionMode?: string;
  visionError?: string;
  detector?: string;
}

const PHONE = "__phone__";
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
const boxStyle = (b: BBox) => ({ left: pct(b.x), top: pct(b.y), width: pct(b.width), height: pct(b.height) });

export function LiveCamera({
  zones, onZonesChange, onStatus,
}: { zones: Zone[]; onZonesChange: (z: Zone[]) => void; onStatus: (s: CameraStatus) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceIdRaw] = useState<string>("");
  const [status, setStatus] = useState<CameraStatus>({ state: "off", analysisFps: 0 });
  const [analyzing, setAnalyzing] = useState(true);
  const [tracked, setTracked] = useState<TrackedDetection[]>([]);
  // Detector boxes for the latest frame, shown instantly while the vision model names them (~1.5 s later).
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [background, setBackground] = useState<Detection[]>([]);
  const [aspect, setAspect] = useState(16 / 9);
  const [editZone, setEditZone] = useState<string | null>(null);
  const [draft, setDraft] = useState<BBox | null>(null);

  const update = useCallback((s: Partial<CameraStatus>) => setStatus((p) => ({ ...p, ...s })), []);
  const setDeviceId = useCallback((next: string | ((cur: string) => string)) => {
    setDeviceIdRaw((cur) => {
      const id = typeof next === "function" ? next(cur) : next;
      if (id && id !== cur) update({ state: "starting" });
      return id;
    });
  }, [update]);
  useEffect(() => {
    onStatus(status);
  }, [status, onStatus]);

  // ---- device discovery: default to the built-in camera; an iPhone (Continuity Camera) is one pick away ----
  const refreshDevices = useCallback(async () => {
    const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    setDevices(all);
    if (!all.length) update({ state: "none" });
    setDeviceId((cur) => cur && all.some((d) => d.deviceId === cur) ? cur : (all.find((d) => !/iphone|desk view/i.test(d.label)) ?? all[0])?.deviceId ?? "");
  }, [update, setDeviceId]);

  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia) {
      Promise.resolve().then(() => update({ state: "error", visionError: "This browser has no camera API (needs https or localhost)." }));
      return;
    }
    // Ask once so device labels (e.g. "iPhone Camera") become visible, then enumerate.
    navigator.mediaDevices.getUserMedia({ video: true })
      .then((s) => { s.getTracks().forEach((t) => t.stop()); return refreshDevices(); })
      .catch((e: DOMException) => update({ state: e.name === "NotAllowedError" ? "denied" : "none" }));
    navigator.mediaDevices.addEventListener("devicechange", refreshDevices);
    return () => navigator.mediaDevices.removeEventListener("devicechange", refreshDevices);
  }, [refreshDevices, update]);

  // ---- open the selected camera ----
  useEffect(() => {
    if (!deviceId || deviceId === PHONE) return; // the phone stream arrives via <PhoneCamera>
    let stream: MediaStream | undefined;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        const track = s.getVideoTracks()[0];
        const st = track.getSettings();
        track.onended = () => update({ state: "none", visionError: "Camera disconnected. Pick another camera." });
        if (videoRef.current) videoRef.current.srcObject = s;
        update({ state: "live", label: track.label, resolution: `${st.height ?? "?"}p`, cameraFps: Math.round(st.frameRate ?? 30), visionError: undefined });
      })
      .catch((e: DOMException) => update({ state: e.name === "NotAllowedError" ? "denied" : "error", visionError: e.message }));
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [deviceId, update]);

  // ---- sampler: cheap thumbnail diff every 250ms; only changed frames go to the detector and vision model ----
  useEffect(() => {
    if (status.state !== "live" || !analyzing) return;
    const thumb = Object.assign(document.createElement("canvas"), { width: SAMPLING.thumbW, height: SAMPLING.thumbH });
    const tctx = thumb.getContext("2d", { willReadFrequently: true })!;
    const detector = createDetector();
    let useDetector = true;
    detector.ready
      .then((d) => update({ detector: `EfficientDet · ${d}` }))
      .catch((e: Error) => {
        useDetector = false;
        update({ detector: `off (${e.message.slice(0, 60)})` });
      });
    let lastThumb = new Uint8ClampedArray();
    let lastSent = 0;
    let inFlight = false;
    const sentAt: number[] = [];

    // Fallback when the detector can't run: plain downscaled JPEG, no numbered boxes.
    const plainJpeg = (v: HTMLVideoElement) => {
      const scale = Math.min(1, SAMPLING.maxDim / Math.max(v.videoWidth, v.videoHeight));
      const c = Object.assign(document.createElement("canvas"), { width: Math.round(v.videoWidth * scale), height: Math.round(v.videoHeight * scale) });
      c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", SAMPLING.jpegQuality);
    };

    const id = setInterval(async () => {
      const v = videoRef.current;
      if (!v || v.readyState < 2 || !v.videoWidth || document.hidden) return;
      tctx.drawImage(v, 0, 0, thumb.width, thumb.height);
      const px = tctx.getImageData(0, 0, thumb.width, thumb.height).data;
      const now = performance.now();
      if (!shouldAnalyze(frameDiff(px, lastThumb), now - lastSent, inFlight)) return;

      inFlight = true;
      lastSent = now;
      lastThumb = px;
      try {
        let image: string;
        let found: Proposal[] = [];
        if (useDetector) {
          try {
            const r = await detector.detect(await createImageBitmap(v), SAMPLING.maxDim, SAMPLING.jpegQuality);
            found = r.proposals;
            setProposals(found); // previous named boxes stay until the new result replaces them
            image = await blobToDataUrl(r.jpeg);
            update({ detector: `EfficientDet · ${Math.round(r.ms)}ms` });
          } catch {
            useDetector = false;
            image = plainJpeg(v);
          }
        } else {
          image = plainJpeg(v);
        }
        const r = await api<{ tracked: TrackedDetection[]; background: Detection[]; latency_ms: number; mode: string; model: string }>("/api/vision", {
          method: "POST", body: JSON.stringify({ image, proposals: found }),
        });
        setTracked(r.tracked);
        setBackground(r.background ?? []);
        setProposals([]);
        sentAt.push(Date.now());
        while (sentAt[0] < Date.now() - 10_000) sentAt.shift();
        update({ visionLatency: r.latency_ms, visionMode: `${r.mode} · ${r.model}`, analysisFps: +(sentAt.length / 10).toFixed(1), visionError: undefined });
      } catch (e) {
        update({ visionError: (e as Error).message });
      } finally {
        inFlight = false;
      }
    }, SAMPLING.tickMs);
    return () => {
      clearInterval(id);
      detector.close();
    };
  }, [status.state, analyzing, update]);

  // ---- zone editor: drag a rectangle over the video for the selected zone ----
  const start = useRef<{ x: number; y: number } | null>(null);
  const rel = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const onDown = (e: React.PointerEvent) => {
    if (!editZone) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    start.current = rel(e);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!start.current) return;
    const p = rel(e), s = start.current;
    setDraft({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), width: Math.abs(p.x - s.x), height: Math.abs(p.y - s.y) });
  };
  const onUp = () => {
    if (draft && editZone && draft.width > 0.03 && draft.height > 0.03)
      onZonesChange(zones.map((z) => (z.id === editZone ? { ...z, rect: draft } : z)));
    start.current = null;
    setDraft(null);
  };

  return (
    <section aria-label="Live camera" className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={deviceId} onValueChange={(v) => setDeviceId(v ?? "")}>
          <SelectTrigger className="h-10 w-64" aria-label="Camera source">
            <SelectValue placeholder="Choose camera">{(v: string) => v === PHONE ? "📱 Phone camera" : devices.find((d) => d.deviceId === v)?.label || (v ? "Camera" : "Choose camera")}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {devices.map((d, i) => (
              <SelectItem key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</SelectItem>
            ))}
            <SelectItem value={PHONE}>📱 Phone camera (scan a QR code)</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Switch id="analyze" checked={analyzing} onCheckedChange={setAnalyzing} />
          <Label htmlFor="analyze">AI analysis</Label>
        </div>
        <Button variant="outline" size="sm" className="ml-auto" aria-pressed={!!editZone} onClick={() => setEditZone(editZone ? null : zones[0]?.id ?? null)}>
          {editZone ? "Done editing zones" : "Edit zones"}
        </Button>
      </div>

      {deviceId === PHONE && (
        <PhoneCamera
          onStream={(stream) => {
            if (videoRef.current) videoRef.current.srcObject = stream;
            update({ state: "live", label: "Phone camera", resolution: "phone", cameraFps: 8, visionError: undefined });
          }}
          onClose={() => {
            api("/api/phone/pair", { method: "DELETE" }).catch(() => {});
            if (videoRef.current) videoRef.current.srcObject = null;
            setDeviceId(devices.find((d) => !/iphone|desk view/i.test(d.label))?.deviceId ?? devices[0]?.deviceId ?? "");
          }}
        />
      )}

      {editZone && (
        <div role="group" aria-label="Zone to draw" className="flex flex-wrap gap-2 text-sm">
          <span className="text-muted-foreground">Drag on the video to place:</span>
          {zones.map((z) => (
            <Button key={z.id} size="sm" variant={z.id === editZone ? "default" : "secondary"} onClick={() => setEditZone(z.id)}>{z.name}</Button>
          ))}
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => onZonesChange(DEFAULT_ZONES)}>Reset zones</Button>
        </div>
      )}

      {/* Sized to the stream's own aspect ratio so boxes (normalized to the full frame) line up exactly. */}
      <div
        className="relative mx-auto overflow-hidden rounded-xl bg-neutral-900 select-none"
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
        style={{ aspectRatio: aspect, width: `min(100%, calc(62dvh * ${aspect}))`, cursor: editZone ? "crosshair" : undefined, touchAction: editZone ? "none" : undefined }}
      >
        <video ref={videoRef} autoPlay playsInline muted className="absolute inset-0 h-full w-full" aria-label="Live camera feed"
          onLoadedMetadata={(e) => { const v = e.currentTarget; if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight); }}
          onResize={(e) => { const v = e.currentTarget; if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight); }} />

        {/* zones */}
        {zones.map((z) => (
          <div key={z.id} style={boxStyle(z.rect)}
            className={`absolute border border-dashed ${z.id === editZone ? "border-amber-300 bg-amber-300/10" : "border-white/35"}`}>
            <span className="absolute left-1 top-1 rounded bg-black/55 px-1.5 py-0.5 text-[11px] font-medium text-white/90">{z.name}</span>
          </div>
        ))}
        {draft && <div style={boxStyle(draft)} className="absolute border-2 border-amber-300 bg-amber-300/20" />}

        {/* background contents: shown faintly, never remembered */}
        {background.map((d, i) => (
          <div key={`b${i}`} style={boxStyle(d.bbox)} className="absolute rounded border border-white/40">
            <span className="absolute left-0 top-0 rounded-br bg-black/45 px-1 text-[10px] text-white/80">{d.label}</span>
          </div>
        ))}

        {/* detector boxes, shown instantly while the vision model names them */}
        {tracked.length === 0 && proposals.map((p) => (
          <div key={`p${p.mark}`} style={boxStyle(p.bbox)} className="absolute rounded-md border-2 border-sky-300/90">
            <span className={`absolute left-0 whitespace-nowrap rounded bg-sky-600/90 px-1.5 py-0.5 text-xs font-medium text-white ${p.bbox.y < 0.08 ? "top-full mt-1" : "-top-1 -translate-y-full"}`}>
              {p.label} · identifying…
            </span>
          </div>
        ))}

        {/* named detections (solid = precise detector box, dashed = approximate box from the vision model) */}
        {tracked.map((d, i) => {
          const damaged = d.state === "damaged";
          const zoneName = zones.find((z) => z.id === d.zone)?.name ?? "Unmapped area";
          return (
            <div key={`${d.object_id}-${i}`} style={boxStyle(d.bbox)}
              className={`absolute rounded-md border-[3px] transition-all duration-300 ${d.box_source === "vision" ? "border-dashed" : ""} ${damaged ? "border-red-500" : "border-emerald-400"}`}>
              <div className={`absolute whitespace-nowrap ${d.bbox.x + d.bbox.width > 0.6 ? "right-0" : "left-0"} ${d.bbox.y < 0.14 ? "top-full mt-1" : "-top-1 -translate-y-full"} rounded-md px-2 py-1 text-xs font-semibold leading-tight text-white shadow ${damaged ? "bg-red-600" : "bg-emerald-600"}`}>
                <div className="text-sm">{d.label}</div>
                <div className="font-normal opacity-95">{Math.round(d.confidence * 100)}% · {zoneName} · {d.state.toUpperCase()}</div>
              </div>
            </div>
          );
        })}

        {/* status */}
        <div className="absolute bottom-3 left-3 flex flex-wrap gap-2">
          {status.state === "live" ? (
            <>
              <Badge className="bg-red-600 text-white"><span className="mr-1 inline-block size-2 animate-pulse rounded-full bg-white" />LIVE</Badge>
              <Badge variant="secondary">{status.resolution} · ~{status.cameraFps} FPS camera</Badge>
              <Badge variant="secondary">{analyzing ? `${status.analysisFps} FPS AI${status.visionLatency ? ` · ${status.visionLatency}ms` : ""}` : "AI paused"}</Badge>
              {analyzing && status.detector && <Badge variant="secondary">{status.detector}</Badge>}
            </>
          ) : (
            <Badge variant="secondary">{deviceId === PHONE && status.state === "starting" ? "Waiting for your phone…" : STATE_TEXT[status.state]}</Badge>
          )}
        </div>
      </div>
      {status.visionError && <p role="alert" className="text-sm text-destructive">{status.visionError}</p>}
      {status.state === "live" && (
        <p className="text-sm text-muted-foreground">Solid boxes are precise (on-device detector); dashed boxes are approximate (named by the vision model only).</p>
      )}
    </section>
  );
}

const STATE_TEXT: Record<CameraStatus["state"], string> = {
  off: "Camera off", starting: "Starting camera…", live: "LIVE",
  denied: "Camera permission denied: allow it in the browser's site settings",
  none: "No camera available", error: "Camera error",
};
