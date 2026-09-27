import { test } from "node:test";
import assert from "node:assert/strict";
import { observationText, parseObservation } from "../lib/cognee";
import type { MemoryEvent } from "../lib/types";

const ev: MemoryEvent = {
  type: "STATE_CHANGED", object_id: "charger-1", label: "USB-C phone charger", zone: "hall-back-table",
  state: "damaged", previous_state: "normal", damage_description: "frayed cable near connector",
  confidence: 0.884, timestamp: "2026-09-27T16:05:02.000Z", source: "live_camera",
};

test("observation text round-trips through the parser", () => {
  const o = parseObservation(observationText(ev), "d-1");
  assert.deepEqual(
    [o?.object_id, o?.zone, o?.state, o?.confidence, o?.timestamp, o?.event, o?.damage_description, o?.data_id],
    ["charger-1", "hall-back-table", "damaged", 0.88, "2026-09-27T16:05:02.000Z", "state_changed", "frayed cable near connector", "d-1"],
  );
});

test("parses the '. '-joined chunk format Cognee returned from a merged session", () => {
  // Verbatim shape from Cognee 1.5.4 CHUNKS recall.
  const chunk = "Session ID: smoke-1\n\nQuestion: \n\nAnswer: Observation: Object: USB-C phone charger. Object ID: charger-1. Location zone: hall-back-table. Timestamp: 2026-09-27T16:02:41Z. State: normal. Confidence: 0.94. Event: first_seen. Source: live_camera.";
  const o = parseObservation(chunk);
  assert.equal(o?.zone, "hall-back-table");
  assert.equal(o?.timestamp, "2026-09-27T16:02:41Z");
  assert.equal(o?.state, "normal");
  assert.equal(o?.confidence, 0.94);
});

test("ignores chunks that are not observations (e.g. self-improvement summaries)", () => {
  assert.equal(parseObservation("The charger was in the Hall-back-table zone according to the most recent observation."), null);
});

test("redacts secrets before they reach memory", () => {
  const t = observationText({ ...ev, damage_description: "label reads password=hunter2" });
  assert.ok(!t.includes("hunter2"));
});
