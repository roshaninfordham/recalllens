import { test } from "node:test";
import assert from "node:assert/strict";
import { frameDiff, shouldAnalyze } from "../lib/sampling";

const frame = (v: number) => new Uint8ClampedArray(32 * 18 * 4).fill(v);

test("identical frames diff to 0 and are suppressed until heartbeat", () => {
  assert.equal(frameDiff(frame(100), frame(100)), 0);
  assert.equal(shouldAnalyze(0, 5_000, false), false);
  assert.equal(shouldAnalyze(0, 10_000, false), true);
});

test("major change is analyzed immediately; moderate waits 500ms; idle 2s", () => {
  assert.equal(shouldAnalyze(frameDiff(frame(0), frame(60)), 10, false), true);
  assert.equal(shouldAnalyze(8, 200, false), false);
  assert.equal(shouldAnalyze(8, 600, false), true);
  assert.equal(shouldAnalyze(4, 600, false), false);
  assert.equal(shouldAnalyze(4, 2_100, false), true);
});

test("never overlaps an in-flight request", () => {
  assert.equal(shouldAnalyze(200, 60_000, true), false);
});
