import { ObservationAggregator } from "./aggregator";
import { publish } from "./bus";
import { rememberObservation } from "./cognee";
import { getZones, logEvent, markEvent } from "./db";
import type { Detection, MemoryEvent, TrackedDetection } from "./types";
import { zoneName } from "./zones";

// Server-side state shared by vision, demo events and agent tools (single-process demo server).
const g = globalThis as unknown as {
  __rlPipe?: { agg: ObservationAggregator; current: TrackedDetection[]; lastFrameAt?: string; notified: Set<string>; consentId?: string };
};
export const pipe = (g.__rlPipe ??= { agg: new ObservationAggregator(), current: [], notified: new Set() });

/** Written to Cognee permanent memory; DISAPPEARED is kept local (too noisy to be a durable fact). */
const DURABLE: MemoryEvent["type"][] = ["FIRST_SEEN", "MOVED", "STATE_CHANGED", "REAPPEARED"];

export function sessionId(consentId: string) {
  return `recalllens-${consentId}`;
}

export function describe(e: MemoryEvent): string {
  const where = zoneName(e.zone, getZones());
  switch (e.type) {
    case "FIRST_SEEN": return `${e.label} seen at ${where}`;
    case "MOVED": return `${e.label} moved to ${where}`;
    case "STATE_CHANGED": return `${e.label} state changed → ${e.state.toUpperCase()}`;
    case "REAPPEARED": return `${e.label} reappeared at ${where}`;
    case "DISAPPEARED": return `${e.label} no longer visible (last at ${where})`;
  }
}

export function ingest(detections: Detection[], source: MemoryEvent["source"], consentId: string) {
  pipe.consentId = consentId;
  const now = new Date();
  const { tracked, events } = pipe.agg.ingest(detections, getZones(), now, source);
  pipe.current = tracked;
  pipe.lastFrameAt = now.toISOString();

  for (const e of events) {
    const id = logEvent(e);
    publish({ kind: "memory", title: e.type, detail: describe(e), data: { ...e, id, cognee_status: DURABLE.includes(e.type) ? "pending" : "skipped" } });
    if (!DURABLE.includes(e.type)) {
      markEvent(id, "skipped");
      continue;
    }
    // Fire-and-forget: never block the frame loop on Cognee.
    const t0 = Date.now();
    rememberObservation(e, sessionId(consentId))
      .then((r) => {
        markEvent(id, "stored");
        publish({ kind: "log", level: "ok", title: "COGNEE REMEMBER", detail: `${r.status} · ${Date.now() - t0}ms · ${e.object_id}`, data: { id, cognee_status: "stored" } });
      })
      .catch((err: Error) => {
        markEvent(id, "failed");
        publish({ kind: "log", level: "error", title: "COGNEE REMEMBER FAILED", detail: err.message, data: { id, cognee_status: "failed" } });
      });

    // One concise proactive notice per damaged object.
    if (e.type === "STATE_CHANGED" && e.state === "damaged" && !pipe.notified.has(e.object_id)) {
      pipe.notified.add(e.object_id);
      publish({
        kind: "agent", level: "warn", title: "PROACTIVE",
        detail: `Your ${e.label.toLowerCase()} appears damaged. I can find a compatible replacement if you'd like.`,
      });
    }
  }
  return { tracked, events };
}
