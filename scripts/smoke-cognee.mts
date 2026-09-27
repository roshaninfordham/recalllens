// Live integration check: remember → (wait for merge) → recall → forget, against real Cognee Cloud.
// Usage: node --env-file=.env.local --import tsx scripts/smoke-cognee.mts
import { forgetObservation, recallObject, rememberObservation } from "../lib/cognee.ts";

process.env.COGNEE_DATASET = "recalllens_smoke";
const ts = new Date().toISOString();
const t0 = Date.now();
const r = await rememberObservation(
  { type: "FIRST_SEEN", object_id: "charger-9", label: "USB-C phone charger", zone: "desk", state: "normal", confidence: 0.93, timestamp: ts, source: "demo_event" },
  `smoke-${Date.now()}`,
);
console.log(`remember: ${r.status} in ${Date.now() - t0}ms`);
for (let i = 0; i < 12; i++) {
  await new Promise((s) => setTimeout(s, 10_000));
  const t1 = Date.now();
  const hits = (await recallObject("charger location", "charger")).filter((o) => o.timestamp === ts);
  console.log(`recall #${i + 1}: ${hits.length} match in ${Date.now() - t1}ms`);
  if (hits[0]) {
    console.log(hits[0]);
    if (hits[0].data_id) console.log("forget:", await forgetObservation(hits[0].data_id));
    process.exit(0);
  }
}
console.error("observation never became recallable");
process.exit(1);
