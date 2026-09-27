"use client";
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { api, consentId } from "@/lib/client";

type Phase = "starting" | "waiting" | "live" | "paused" | "error";

/**
 * Pairs a phone by QR code and turns its frames into a MediaStream for the camera view.
 * The phone POSTs JPEGs through a temporary tunnel; this component polls the latest one and paints it onto a canvas,
 * whose captureStream() feeds the same <video> the built-in camera uses, so detection and memory work unchanged.
 */
export function PhoneCamera({ onStream, onClose }: { onStream: (s: MediaStream) => void; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>("starting");
  const [qr, setQr] = useState<string>();
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const onStreamRef = useRef(onStream);
  useEffect(() => {
    onStreamRef.current = onStream;
  }, [onStream]);

  useEffect(() => {
    let stopped = false;
    let lastAt = 0;
    let stream: MediaStream | undefined;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;

    api<{ url: string }>("/api/phone/pair", { method: "POST" })
      .then(async (r) => {
        if (stopped) return;
        setUrl(r.url);
        setQr(await QRCode.toDataURL(r.url, { margin: 1, width: 240, errorCorrectionLevel: "M" }));
        setPhase("waiting");
      })
      .catch((e: Error) => { setError(e.message); setPhase("error"); });

    const poll = async () => {
      while (!stopped) {
        try {
          const res = await fetch("/api/phone/frame", { headers: { "x-consent-id": consentId() ?? "" }, cache: "no-store" });
          const at = Number(res.headers.get("x-frame-at") ?? 0);
          if (res.status === 200 && at !== lastAt) {
            lastAt = at;
            const bmp = await createImageBitmap(await res.blob());
            if (canvas.width !== bmp.width || canvas.height !== bmp.height) [canvas.width, canvas.height] = [bmp.width, bmp.height];
            ctx.drawImage(bmp, 0, 0);
            bmp.close();
            if (!stream) {
              stream = canvas.captureStream(15);
              onStreamRef.current(stream);
            }
            setPhase("live");
          } else if (lastAt && Date.now() - lastAt > 5000) {
            setPhase("paused");
          }
        } catch {
          // transient; keep polling
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    poll();

    // The tunnel is closed by Disconnect/Cancel (onClose) or the server's idle timeout, not on unmount:
    // React dev mode mounts twice, and closing here would kill the link the QR code shows.
    return () => {
      stopped = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  if (phase === "live" || phase === "paused")
    return (
      <div role="status" className="flex items-center justify-between gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
        <span>{phase === "live" ? "📱 Phone camera connected" : "📱 Phone paused: is the RecallLens page still open on your phone?"}</span>
        <Button size="sm" variant="ghost" onClick={onClose}>Disconnect</Button>
      </div>
    );

  return (
    <div className="flex flex-wrap items-center gap-4 rounded-xl border bg-muted/40 p-4" role="group" aria-label="Connect your phone camera">
      {/* eslint-disable-next-line @next/next/no-img-element -- generated data URL, nothing for next/image to optimize */}
      {qr ? <img src={qr} alt="QR code to open the RecallLens camera page on your phone" width={180} height={180} className="rounded-md bg-white p-1" /> : <div className="size-[180px] animate-pulse rounded-md bg-muted" />}
      <div className="min-w-0 flex-1 space-y-2 text-sm">
        <p className="text-base font-semibold">Use your phone as the camera</p>
        {phase === "starting" && <p className="text-muted-foreground">Opening a secure temporary link (about 20 seconds)…</p>}
        {phase === "waiting" && (
          <>
            <ol className="list-decimal space-y-1 pl-5">
              <li>Scan the QR code with your phone camera.</li>
              <li>Tap <strong>Start</strong> and allow camera access.</li>
            </ol>
            <p className="text-muted-foreground">Works on any network. Frames go only to this laptop and are not stored. The link is single-use and closes when you disconnect or after 10 idle minutes.</p>
            {url && <p className="break-all font-mono text-xs text-muted-foreground">{url.replace(/t=.*/, "t=…")}</p>}
          </>
        )}
        {phase === "error" && <p role="alert" className="text-destructive">Couldn’t open the phone link: {error}</p>}
        <Button size="sm" variant="outline" onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}
