import { test } from "node:test";
import assert from "node:assert/strict";
import { ObservationAggregator, categoryOf } from "../lib/aggregator";
import { DEFAULT_ZONES, zoneFor } from "../lib/zones";
import type { Detection } from "../lib/types";

const charger = (x: number, y: number, state: Detection["state"] = "normal", confidence = 0.94): Detection => ({
  label: "USB-C phone charger", confidence, state, state_confidence: 0.9,
  bbox: { x, y, width: 0.1, height: 0.1 },
});
const at = (s: number) => new Date(Date.UTC(2026, 8, 27, 16, 0, s));
const BACK = [0.7, 0.7] as const; // hall-back-table quadrant
const DESK = [0.1, 0.1] as const;

test("zones resolve from bbox centre", () => {
  assert.equal(zoneFor(charger(...BACK).bbox, DEFAULT_ZONES), "hall-back-table");
  assert.equal(zoneFor(charger(...DESK).bbox, DEFAULT_ZONES), "desk");
});

test("labels collapse to categories", () => {
  assert.equal(categoryOf("USB-C phone charger"), "charger");
  assert.equal(categoryOf("house keys"), "keys");
});

test("20 stable sightings produce exactly one FIRST_SEEN", () => {
  const a = new ObservationAggregator();
  const all = Array.from({ length: 20 }, (_, i) => a.ingest([charger(...BACK)], DEFAULT_ZONES, at(i)).events).flat();
  assert.deepEqual(all.map((e) => e.type), ["FIRST_SEEN"]);
  assert.equal(all[0].object_id, "charger-1");
  assert.equal(all[0].zone, "hall-back-table");
});

test("move needs two confirming frames, then emits MOVED with previous zone", () => {
  const a = new ObservationAggregator();
  a.ingest([charger(...BACK)], DEFAULT_ZONES, at(0));
  assert.equal(a.ingest([charger(...DESK)], DEFAULT_ZONES, at(1)).events.length, 0, "single-frame flicker ignored");
  const [e] = a.ingest([charger(...DESK)], DEFAULT_ZONES, at(2)).events;
  assert.equal(e.type, "MOVED");
  assert.equal(e.previous_zone, "hall-back-table");
  assert.equal(e.zone, "desk");
});

test("damage emits one STATE_CHANGED", () => {
  const a = new ObservationAggregator();
  a.ingest([charger(...BACK)], DEFAULT_ZONES, at(0));
  a.ingest([charger(...BACK, "damaged")], DEFAULT_ZONES, at(1));
  const ev = [2, 3, 4].flatMap((s) => a.ingest([charger(...BACK, "damaged")], DEFAULT_ZONES, at(s)).events);
  assert.deepEqual(ev.map((e) => [e.type, e.state, e.previous_state]), [["STATE_CHANGED", "damaged", "normal"]]);
});

test("low-confidence detections never create memory", () => {
  const a = new ObservationAggregator();
  assert.equal(a.ingest([charger(...BACK, "normal", 0.4)], DEFAULT_ZONES, at(0)).events.length, 0);
});

test("disappear after timeout, then reappear", () => {
  const a = new ObservationAggregator({ disappearMs: 10_000 });
  a.ingest([charger(...BACK)], DEFAULT_ZONES, at(0));
  assert.equal(a.ingest([], DEFAULT_ZONES, at(5)).events.length, 0);
  assert.equal(a.ingest([], DEFAULT_ZONES, at(11)).events[0].type, "DISAPPEARED");
  assert.equal(a.ingest([], DEFAULT_ZONES, at(20)).events.length, 0, "only once");
  const [e] = a.ingest([charger(...DESK)], DEFAULT_ZONES, at(30)).events;
  assert.equal(e.type, "REAPPEARED");
  assert.equal(e.previous_zone, "hall-back-table");
});
