"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/client";
import { SAMPLING, frameDiff, shouldAnalyze } from "@/lib/sampling";
import type { BBox, TrackedDetection, Zone } from "@/lib/types";

export interface CameraStatus {
  state: "off" | "starting" | "live" | "denied" | "none" | "error";
  label?: string;
  resolution?: string;
  cameraFps?: number;
  analysisFps: number;
  visionLatency?: number;
  visionMode?: string;
  visionError?: string;
}

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
  useEffect(() => onStatus(status), [status, onStatus]);

  // ---- device discovery: prefer the iPhone (Continuity Camera) when present ----
  const refreshDevices = useCallback(async () => {
    const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    setDevices(all);
    if (!all.length) update({ state: "none" });
    setDeviceId((cur) => cur && all.some((d) => d.deviceId === cur) ? cur : (all.find((d) => /iphone/i.test(d.label)) ?? all[0])?.deviceId ?? "");
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
    if (!deviceId) return;
    let stream: MediaStream | undefined;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        const track = s.getVideoTracks()[0];
        const st = track.getSettings();
        track.onended = () => update({ state: "none", visionError: "Camera disconnected. Reconnect the iPhone or pick another camera." });
        if (videoRef.current) videoRef.current.srcObject = s;
        update({ state: "live", label: track.label, resolution: `${st.height ?? "?"}p`, cameraFps: Math.round(st.frameRate ?? 30), visionError: undefined });
      })
      .catch((e: DOMException) => update({ state: e.name === "NotAllowedError" ? "denied" : "error", visionError: e.message }));
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [deviceId, update]);

  // ---- sampler: cheap thumbnail diff every 250ms; send a compressed frame only when it matters ----
  useEffect(() => {
    if (status.state !== "live" || !analyzing) return;
    const thumb = Object.assign(document.createElement("canvas"), { width: SAMPLING.thumbW, height: SAMPLING.thumbH });
    const tctx = thumb.getContext("2d", { willReadFrequently: true })!;
    const full = document.createElement("canvas");
    let lastThumb = new Uint8ClampedArray();
    let lastSent = 0;
    let inFlight = false;
    const sentAt: number[] = [];

    const id = setInterval(async () => {
      const v = videoRef.current;
      if (!v || v.readyState < 2 || document.hidden) return;
      tctx.drawImage(v, 0, 0, thumb.width, thumb.height);
      const px = tctx.getImageData(0, 0, thumb.width, thumb.height).data;
      const now = performance.now();
      if (!shouldAnalyze(frameDiff(px, lastThumb), now - lastSent, inFlight)) return;

      inFlight = true;
      lastSent = now;
      lastThumb = px;
      const scale = Math.min(1, SAMPLING.maxDim / Math.max(v.videoWidth, v.videoHeight));
      full.width = Math.round(v.videoWidth * scale);
      full.height = Math.round(v.videoHeight * scale);
      const fctx = full.getContext("2d")!;
      fctx.drawImage(v, 0, 0, full.width, full.height);
      drawZones(fctx, zones, full.width, full.height); // the model reads the zone labels off the frame
      const image = full.toDataURL("image/jpeg", SAMPLING.jpegQuality);

      try {
        const r = await api<{ tracked: TrackedDetection[]; latency_ms: number; mode: string; model: string }>("/api/vision", {
          method: "POST", body: JSON.stringify({ image }),
        });
        setTracked(r.tracked);
        sentAt.push(Date.now());
        while (sentAt[0] < Date.now() - 10_000) sentAt.shift();
        update({ visionLatency: r.latency_ms, visionMode: `${r.mode} · ${r.model}`, analysisFps: +(sentAt.length / 10).toFixed(1), visionError: undefined });
      } catch (e) {
        update({ visionError: (e as Error).message });
      } finally {
        inFlight = false;
      }
    }, SAMPLING.tickMs);
    return () => clearInterval(id);
  }, [status.state, analyzing, zones, update]);

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
            <SelectValue placeholder="Choose camera" />
          </SelectTrigger>
          <SelectContent>
            {devices.map((d, i) => (
              <SelectItem key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</SelectItem>
            ))}
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

      {editZone && (
        <div role="group" aria-label="Zone to draw" className="flex flex-wrap gap-2 text-sm">
          <span className="text-muted-foreground">Drag on the video to place:</span>
          {zones.map((z) => (
            <Button key={z.id} size="sm" variant={z.id === editZone ? "default" : "secondary"} onClick={() => setEditZone(z.id)}>{z.name}</Button>
          ))}
        </div>
      )}

      <div
        className="relative aspect-video w-full overflow-hidden rounded-xl bg-neutral-900 select-none"
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
        style={{ cursor: editZone ? "crosshair" : undefined, touchAction: editZone ? "none" : undefined }}
      >
        <video ref={videoRef} autoPlay playsInline muted className="absolute inset-0 h-full w-full object-cover" aria-label="Live camera feed" />

        {/* zones */}
        {zones.map((z) => (
          <div key={z.id} style={boxStyle(z.rect)}
            className={`absolute border border-dashed ${z.id === editZone ? "border-amber-300 bg-amber-300/10" : "border-white/35"}`}>
            <span className="absolute left-1 top-1 rounded bg-black/55 px-1.5 py-0.5 text-[11px] font-medium text-white/90">{z.name}</span>
          </div>
        ))}
        {draft && <div style={boxStyle(draft)} className="absolute border-2 border-amber-300 bg-amber-300/20" />}

        {/* detections */}
        {tracked.map((d, i) => {
          const damaged = d.state === "damaged";
          const zoneName = zones.find((z) => z.id === d.zone)?.name ?? "Unmapped area";
          return (
            <div key={`${d.object_id}-${i}`} style={boxStyle(d.bbox)}
              className={`absolute rounded-md border-[3px] transition-all duration-300 ${damaged ? "border-red-500" : "border-emerald-400"}`}>
              <div className={`absolute left-0 whitespace-nowrap ${d.bbox.y < 0.14 ? "top-full mt-1" : "-top-1 -translate-y-full"} rounded-md px-2 py-1 text-xs font-semibold leading-tight text-white shadow ${damaged ? "bg-red-600" : "bg-emerald-600"}`}>
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
            </>
          ) : (
            <Badge variant="secondary">{STATE_TEXT[status.state]}</Badge>
          )}
        </div>
      </div>
      {status.visionError && <p role="alert" className="text-sm text-destructive">{status.visionError}</p>}
      {status.state === "live" && !/iphone/i.test(status.label ?? "") && (
        <p className="text-sm text-muted-foreground">Tip: place your iPhone near the Mac (same Apple ID, Wi-Fi and Bluetooth on) and it appears here as a camera.</p>
      )}
    </section>
  );
}

const STATE_TEXT: Record<CameraStatus["state"], string> = {
  off: "Camera off", starting: "Starting camera…", live: "LIVE",
  denied: "Camera permission denied: allow it in the browser's site settings",
  none: "No camera available", error: "Camera error",
};

function drawZones(ctx: CanvasRenderingContext2D, zones: Zone[], w: number, h: number) {
  ctx.save();
  ctx.lineWidth = 2;
  ctx.font = `bold ${Math.round(h / 28)}px sans-serif`;
  for (const z of zones) {
    const [x, y, zw, zh] = [z.rect.x * w, z.rect.y * h, z.rect.width * w, z.rect.height * h];
    ctx.strokeStyle = "rgba(255,210,0,0.9)";
    ctx.setLineDash([8, 6]);
    ctx.strokeRect(x, y, zw, zh);
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    const label = z.id;
    ctx.fillRect(x + 2, y + 2, ctx.measureText(label).width + 10, h / 22);
    ctx.fillStyle = "#ffd200";
    ctx.fillText(label, x + 7, y + h / 28);
  }
  ctx.restore();
}
