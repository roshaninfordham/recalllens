import { requireConsent } from "@/lib/guard";
import { ingest } from "@/lib/pipeline";
import { publish } from "@/lib/bus";
import type { Detection } from "@/lib/types";

// Failsafe only: injects clearly-labelled synthetic detections (source "demo_event") through the real
// aggregator → Cognee path. Use if live vision is unavailable during the presentation.
const charger = (state: Detection["state"]): Detection => ({
  label: "USB-C phone charger", confidence: 0.93, state, state_confidence: 0.9,
  bbox: { x: 0.68, y: 0.66, width: 0.14, height: 0.14 }, // Hall / Back Table quadrant
  ...(state === "damaged" ? { damage_description: "frayed cable near the connector" } : {}),
});

export async function POST(req: Request) {
  const denied = requireConsent(req);
  if (denied) return denied;
  const { kind } = (await req.json().catch(() => ({}))) as { kind?: string };
  const state = kind === "damaged" ? "damaged" : kind === "first_seen" ? "normal" : null;
  if (!state) return Response.json({ error: "kind must be first_seen | damaged" }, { status: 400 });
  publish({ kind: "log", level: "warn", title: "DEMO EVENT", detail: `Simulated: charger ${state} (not from camera)` });
  const consent = req.headers.get("x-consent-id")!;
  // Two frames so the aggregator's hysteresis accepts a state change, exactly like live frames.
  ingest([charger(state)], "demo_event", consent);
  const r = ingest([charger(state)], "demo_event", consent);
  return Response.json(r);
}
