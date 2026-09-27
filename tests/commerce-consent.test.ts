import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoCatalog } from "../lib/commerce";

const dbPath = join(tmpdir(), `rl-test-${process.pid}.db`);
process.env.RECALLLENS_DB = dbPath;
let db: typeof import("../lib/db");
before(async () => {
  db = await import("../lib/db");
});
after(() => rmSync(dbPath, { force: true }));

test("search filters by phone compatibility", async () => {
  const hits = await demoCatalog.searchProducts("replacement USB-C charger", "Demo Phone");
  assert.ok(hits.length > 0);
  assert.ok(hits.every((p) => p.compatible.includes("demo-phone")));
  assert.ok(!hits.some((p) => p.connector === "Lightning"));
});

test("consent rejects missing choices and wrong policy", () => {
  const choices = { activity_recording: true, cognee_memory_storage: true, sensitive_information_acknowledged: true };
  assert.equal(db.validateConsent({ policy_version: "1.0", participant_id: "p-abc123", choices }).ok, true);
  assert.equal(db.validateConsent({ policy_version: "0.9", participant_id: "p-abc123", choices }).ok, false);
  assert.equal(db.validateConsent({ policy_version: "1.0", participant_id: "p-abc123", choices: { ...choices, cognee_memory_storage: false } }).ok, false);
  assert.equal(db.validateConsent({ policy_version: "1.0", participant_id: "x", choices }).ok, false);
});

test("consent receipt persists all fields together and is immutable", () => {
  const r = db.saveConsent("p-abc123", { activity_recording: true, cognee_memory_storage: true, sensitive_information_acknowledged: true });
  const got = db.getConsent(r.consent_id);
  assert.deepEqual(got, r);
  assert.equal(got?.policy_version, "1.0");
  assert.throws(() => (globalThis as unknown as { __rlDb: { exec(sql: string): void } }).__rlDb.exec(`UPDATE consent_receipts SET policy_version='2.0'`), /immutable/);
});

test("cart add", () => {
  db.clearCart();
  db.addCart("charger-usbc-20w", "RecallLens Agent");
  assert.equal(db.getCart()[0].product_id, "charger-usbc-20w");
});
