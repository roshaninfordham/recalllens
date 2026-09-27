import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "../lib/redact";

test("redacts secrets and PII, keeps observation text", () => {
  const out = redact(
    "USB-C charger on back table. note: password=hunter2 key sk-ant-abcdefghijklmnopqrstuv card 4111 1111 1111 1111 mail a@b.io",
  );
  assert.match(out, /USB-C charger on back table/);
  for (const leaked of ["hunter2", "sk-ant-", "4111", "a@b.io"]) assert.ok(!out.includes(leaked), leaked);
});

test("leaves timestamps and confidences alone", () => {
  const s = "Timestamp: 2026-09-27T16:02:41Z Confidence: 0.94";
  assert.equal(redact(s), s);
});
