import { test } from "node:test";
import assert from "node:assert/strict";
import { band, latestTrustworthy } from "../lib/confidence";

test("confidence bands follow the spec thresholds", () => {
  assert.deepEqual([0.95, 0.9, 0.89, 0.7, 0.69].map(band), ["strong", "strong", "moderate", "moderate", "uncertain"]);
});

test("newest trustworthy observation wins over a newer uncertain one", () => {
  const obs = [{ id: "newest", confidence: 0.5 }, { id: "older", confidence: 0.88 }, { id: "oldest", confidence: 0.95 }];
  assert.equal(latestTrustworthy(obs)?.id, "older");
  assert.equal(latestTrustworthy([{ id: "only", confidence: 0.4 }])?.id, "only");
  assert.equal(latestTrustworthy([]), undefined);
});
