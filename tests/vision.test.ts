import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDetections, sanitizeProposals } from "../lib/vision";
import type { Proposal } from "../lib/types";

const proposals: Proposal[] = [
  { mark: 1, label: "cell phone", score: 0.45, bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
  { mark: 2, label: "cup", score: 0.8, bbox: { x: 0.5, y: 0.5, width: 0.1, height: 0.2 } },
  { mark: 3, label: "remote", score: 0.35, bbox: { x: 0.7, y: 0.1, width: 0.1, height: 0.1 } },
];
const obj = (o: Record<string, unknown>) => ({ confidence: 0.9, box: { x: 0, y: 0, width: 0, height: 0 }, state: "normal", state_confidence: 0.9, damage_description: "", ...o });

test("a named numbered box keeps the detector's precise box and the model's specific name", () => {
  const out = parseDetections(JSON.stringify({ objects: [obj({ mark: 1, label: "white USB-C charger" })] }), proposals);
  const charger = out.find((d) => d.label === "white USB-C charger");
  assert.deepEqual(charger?.bbox, proposals[0].bbox);
  assert.equal(charger?.box_source, "detector");
});

test("mark 0 uses the model's own box; unnamed confident proposals survive, weak ones do not", () => {
  const out = parseDetections(JSON.stringify({ objects: [obj({ mark: 0, label: "house keys", box: { x: 0.2, y: 0.6, width: 0.1, height: 0.1 } })] }), proposals);
  assert.deepEqual(out.map((d) => [d.label, d.box_source]), [["house keys", "vision"], ["cup", "detector"]]);
});

test("furniture, duplicate marks and malformed entries are dropped", () => {
  const out = parseDetections(JSON.stringify({ objects: [
    obj({ mark: 0, label: "wooden table", box: { x: 0, y: 0.5, width: 1, height: 0.5 } }),
    obj({ mark: 2, label: "mug" }), obj({ mark: 2, label: "second mug" }),
    obj({ mark: 0, label: "ghost", box: { x: 0.2, y: 0.2, width: 0, height: 0 } }),
    { nonsense: true },
  ] }), proposals);
  assert.deepEqual(out.map((d) => d.label), ["mug"]);
});

test("malformed model output is an error, not a crash", () => {
  assert.throws(() => parseDetections("not json"), /malformed/);
});

test("browser proposals are validated and capped", () => {
  const ok = sanitizeProposals([{ mark: 1, label: "cup", score: 2, bbox: { x: -1, y: 0.2, width: 0.3, height: 0.3 } }, { label: 5 }, "x"]);
  assert.equal(ok.length, 1);
  assert.equal(ok[0].score, 1);
  assert.equal(ok[0].bbox.x, 0);
  assert.equal(sanitizeProposals(Array.from({ length: 50 }, (_, i) => ({ mark: i + 1, label: "cup", score: 0.5, bbox: { x: 0, y: 0, width: 0.1, height: 0.1 } }))).length, 20);
  assert.deepEqual(sanitizeProposals("nope"), []);
});
