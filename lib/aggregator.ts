import type { Detection, MemoryEvent, ObjectState, TrackedDetection, Zone } from "./types";
import { zoneFor } from "./zones";

interface Track {
  object_id: string;
  category: string;
  label: string;
  zone: string;
  state: ObjectState;
  confidence: number;
  cx: number;
  cy: number;
  lastSeen: number;
  visible: boolean;
  pendingZone?: string;
  pendingZoneCount: number;
  pendingState?: ObjectState;
  pendingStateCount: number;
}

export interface AggregatorOptions {
  /** Consecutive agreeing frames before a move/state change is accepted (flicker guard). */
  confirmFrames: number;
  /** Unseen for this long → DISAPPEARED. */
  disappearMs: number;
  /** Detections below this never create or change memory. */
  minConfidence: number;
}

const DEFAULTS: AggregatorOptions = { confirmFrames: 2, disappearMs: 20_000, minConfidence: 0.6 };
const DURABLE_STATES: ObjectState[] = ["normal", "damaged"];

/** Collapses free-form vision labels into a trackable category. */
export function categoryOf(label: string): string {
  const l = label.toLowerCase();
  if (/charger|charging|adapter|power brick|cable|cord/.test(l)) return "charger";
  if (/\bkeys?\b|keychain/.test(l)) return "keys";
  if (/wallet/.test(l)) return "wallet";
  if (/glasses|spectacles|sunglasses/.test(l)) return "glasses";
  if (/phone|iphone|smartphone/.test(l)) return "phone";
  return l.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "object";
}

/**
 * Turns per-frame detections into a small stream of meaningful MemoryEvents.
 * STABLE sightings produce no event; only first sight, moves, state changes,
 * disappearance and reappearance do.
 */
export class ObservationAggregator {
  private tracks = new Map<string, Track>();
  private counters = new Map<string, number>();
  private opts: AggregatorOptions;

  constructor(opts: Partial<AggregatorOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  snapshot(): Track[] {
    return [...this.tracks.values()];
  }

  ingest(
    detections: Detection[],
    zones: Zone[],
    now: Date,
    source: MemoryEvent["source"] = "live_camera",
  ): { tracked: TrackedDetection[]; events: MemoryEvent[] } {
    const t = now.getTime();
    const ts = now.toISOString();
    const events: MemoryEvent[] = [];
    const tracked: TrackedDetection[] = [];
    const claimed = new Set<string>();

    for (const d of detections) {
      const zone = zoneFor(d.bbox, zones);
      const cx = d.bbox.x + d.bbox.width / 2;
      const cy = d.bbox.y + d.bbox.height / 2;
      const category = categoryOf(d.label);
      const confident = d.confidence >= this.opts.minConfidence;

      // Identity: nearest unclaimed track of the same category.
      // ponytail: greedy nearest-centre matching; use Hungarian assignment if many same-class objects matter.
      let track: Track | undefined;
      let best = Infinity;
      for (const tr of this.tracks.values()) {
        if (tr.category !== category || claimed.has(tr.object_id)) continue;
        const dist = Math.hypot(tr.cx - cx, tr.cy - cy);
        if (dist < best) [best, track] = [dist, tr];
      }

      if (!track) {
        if (!confident) {
          tracked.push({ ...d, object_id: `${category}-?`, zone });
          continue;
        }
        const n = (this.counters.get(category) ?? 0) + 1;
        this.counters.set(category, n);
        track = {
          object_id: `${category}-${n}`, category, label: d.label, zone,
          state: DURABLE_STATES.includes(d.state) ? d.state : "normal",
          confidence: d.confidence, cx, cy, lastSeen: t, visible: true,
          pendingZoneCount: 0, pendingStateCount: 0,
        };
        this.tracks.set(track.object_id, track);
        events.push(this.event("FIRST_SEEN", track, ts, source, d));
      } else if (confident) {
        if (!track.visible) {
          const previous_zone = track.zone;
          Object.assign(track, { visible: true, zone, pendingZoneCount: 0 });
          events.push({ ...this.event("REAPPEARED", track, ts, source, d), previous_zone });
        } else {
          const moved = this.confirm(track, "Zone", zone, track.zone);
          if (moved) {
            const previous_zone = track.zone;
            track.zone = zone;
            events.push({ ...this.event("MOVED", track, ts, source, d), previous_zone });
          }
        }
        if (DURABLE_STATES.includes(d.state) && d.state_confidence >= this.opts.minConfidence) {
          const changed = this.confirm(track, "State", d.state, track.state);
          if (changed) {
            const previous_state = track.state;
            track.state = d.state;
            events.push({ ...this.event("STATE_CHANGED", track, ts, source, d), previous_state });
          }
        }
        Object.assign(track, { cx, cy, lastSeen: t, confidence: d.confidence, label: d.label });
      }

      claimed.add(track.object_id);
      tracked.push({ ...d, object_id: track.object_id, zone });
    }

    for (const tr of this.tracks.values()) {
      if (tr.visible && !claimed.has(tr.object_id) && t - tr.lastSeen >= this.opts.disappearMs) {
        tr.visible = false;
        events.push({ ...this.event("DISAPPEARED", tr, ts, source), state: "missing" });
      }
    }
    return { tracked, events };
  }

  /** Hysteresis: a new value must be seen confirmFrames times in a row before it sticks. */
  private confirm<K extends "Zone" | "State">(tr: Track, kind: K, next: string, current: string): boolean {
    const pk = `pending${kind}` as const;
    const ck = `pending${kind}Count` as const;
    if (next === current) {
      tr[ck] = 0;
      return false;
    }
    if (tr[pk] === next) tr[ck]++;
    else {
      (tr as unknown as Record<string, unknown>)[pk] = next;
      tr[ck] = 1;
    }
    if (tr[ck] >= this.opts.confirmFrames) {
      tr[ck] = 0;
      return true;
    }
    return false;
  }

  private event(type: MemoryEvent["type"], tr: Track, timestamp: string, source: MemoryEvent["source"], d?: Detection): MemoryEvent {
    return {
      type, object_id: tr.object_id, label: tr.label, zone: tr.zone, state: tr.state,
      confidence: d?.confidence ?? tr.confidence, timestamp, source,
      ...(d?.damage_description && tr.state === "damaged" ? { damage_description: d.damage_description } : {}),
    };
  }
}
