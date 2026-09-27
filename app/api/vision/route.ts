import { requireConsent } from "@/lib/guard";
import { analyzeFrame, sanitizeProposals } from "@/lib/vision";
import { ingest } from "@/lib/pipeline";
import { publish } from "@/lib/bus";

const MAX_BYTES = 1_500_000; // ~768px JPEG is ~60-150 KB; reject anything absurd

/** One sampled frame in → tracked objects + meaningful events out. The frame is never stored. */
export async function POST(req: Request) {
  const denied = requireConsent(req);
  if (denied) return denied;
  const { image, proposals } = (await req.json().catch(() => ({}))) as { image?: string; proposals?: unknown };
  if (typeof image !== "string" || !/^data:image\/(jpeg|webp|png);base64,/.test(image) || image.length > MAX_BYTES)
    return Response.json({ error: "image must be a jpeg/webp/png data URL under 1.5MB" }, { status: 400 });
  try {
    const r = await analyzeFrame(image, sanitizeProposals(proposals));
    const { tracked, events, background } = ingest(r.detections, "live_camera", req.headers.get("x-consent-id")!);
    publish({ kind: "vision", title: "FRAME ANALYZED", detail: `${tracked.length} object(s) · ${r.latency_ms}ms`, data: { latency_ms: r.latency_ms } });
    return Response.json({ tracked, background, events, mode: r.mode, model: r.model, latency_ms: r.latency_ms });
  } catch (e) {
    const msg = (e as Error).message;
    publish({ kind: "log", level: "error", title: "VISION ERROR", detail: msg });
    return Response.json({ error: msg }, { status: 502 });
  }
}
