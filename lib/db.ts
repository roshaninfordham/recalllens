import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { MemoryEvent, Zone } from "./types";
import { DEFAULT_ZONES } from "./zones";

export const POLICY_VERSION = "1.0";
export const EVENT_ID = "personal-agent-hackathon";

const g = globalThis as unknown as { __rlDb?: DatabaseSync };

function db(): DatabaseSync {
  if (g.__rlDb) return g.__rlDb;
  const d = new DatabaseSync(process.env.RECALLLENS_DB ?? "recalllens.db");
  d.exec(`
    CREATE TABLE IF NOT EXISTS consent_receipts (
      consent_id TEXT PRIMARY KEY,
      participant_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      choices TEXT NOT NULL,
      consented_at TEXT NOT NULL
    );
    -- Receipts are immutable once written.
    CREATE TRIGGER IF NOT EXISTS consent_no_update BEFORE UPDATE ON consent_receipts
      BEGIN SELECT RAISE(ABORT, 'consent receipts are immutable'); END;
    CREATE TABLE IF NOT EXISTS memory_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      cognee_status TEXT NOT NULL DEFAULT 'pending',
      cognee_data_id TEXT
    );
    CREATE TABLE IF NOT EXISTS cart (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      added_by TEXT NOT NULL,
      added_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  g.__rlDb = d;
  return d;
}

// ---------- consent ----------

export interface ConsentChoices {
  activity_recording: boolean;
  cognee_memory_storage: boolean;
  sensitive_information_acknowledged: boolean;
}

export interface ConsentReceipt {
  consent_id: string;
  participant_id: string;
  event_id: string;
  policy_version: string;
  choices: ConsentChoices;
  consented_at: string;
}

const CHOICE_KEYS: (keyof ConsentChoices)[] = [
  "activity_recording",
  "cognee_memory_storage",
  "sensitive_information_acknowledged",
];

export function validateConsent(input: unknown): { ok: true; choices: ConsentChoices; participant_id: string } | { ok: false; error: string } {
  const body = input as { choices?: Record<string, unknown>; participant_id?: unknown; policy_version?: unknown };
  if (body?.policy_version !== POLICY_VERSION) return { ok: false, error: `policy_version must be ${POLICY_VERSION}` };
  if (typeof body.participant_id !== "string" || !/^[A-Za-z0-9-]{6,64}$/.test(body.participant_id))
    return { ok: false, error: "participant_id must be an opaque 6-64 char id" };
  for (const k of CHOICE_KEYS) if (body.choices?.[k] !== true) return { ok: false, error: `choice ${k} must be accepted` };
  const choices = Object.fromEntries(CHOICE_KEYS.map((k) => [k, true])) as unknown as ConsentChoices;
  return { ok: true, choices, participant_id: body.participant_id };
}

export function saveConsent(participant_id: string, choices: ConsentChoices): ConsentReceipt {
  const r: ConsentReceipt = {
    consent_id: randomUUID(), participant_id, event_id: EVENT_ID,
    policy_version: POLICY_VERSION, choices, consented_at: new Date().toISOString(),
  };
  db().prepare("INSERT INTO consent_receipts VALUES (?,?,?,?,?,?)")
    .run(r.consent_id, r.participant_id, r.event_id, r.policy_version, JSON.stringify(r.choices), r.consented_at);
  return r;
}

export function getConsent(consent_id: string | null | undefined): ConsentReceipt | null {
  if (!consent_id) return null;
  const row = db().prepare("SELECT * FROM consent_receipts WHERE consent_id = ?").get(consent_id) as Record<string, string> | undefined;
  return row ? { ...(row as unknown as ConsentReceipt), choices: JSON.parse(row.choices) } : null;
}

// ---------- memory event log (local mirror for the timeline; Cognee is the memory) ----------

export interface StoredEvent extends MemoryEvent {
  id: number;
  cognee_status: "pending" | "stored" | "failed" | "skipped";
  cognee_data_id?: string;
}

export function logEvent(e: MemoryEvent): number {
  const r = db().prepare("INSERT INTO memory_events (event) VALUES (?)").run(JSON.stringify(e));
  return Number(r.lastInsertRowid);
}

export function markEvent(id: number, status: StoredEvent["cognee_status"], dataId?: string) {
  db().prepare("UPDATE memory_events SET cognee_status = ?, cognee_data_id = ? WHERE id = ?").run(status, dataId ?? null, id);
}

export function recentEvents(limit = 50): StoredEvent[] {
  const rows = db().prepare("SELECT * FROM memory_events ORDER BY id DESC LIMIT ?").all(limit) as Record<string, string>[];
  return rows.map((r) => ({
    ...JSON.parse(r.event), id: Number(r.id), cognee_status: r.cognee_status, cognee_data_id: r.cognee_data_id ?? undefined,
  }));
}

export function clearEvents() {
  db().exec("DELETE FROM memory_events");
}

// ---------- cart ----------

export function addCart(product_id: string, added_by: string) {
  db().prepare("INSERT INTO cart (product_id, added_by, added_at) VALUES (?,?,?)").run(product_id, added_by, new Date().toISOString());
}

export function getCart(): { product_id: string; added_by: string; added_at: string }[] {
  return db().prepare("SELECT product_id, added_by, added_at FROM cart ORDER BY id").all() as never;
}

export function clearCart() {
  db().exec("DELETE FROM cart");
}

// ---------- settings ----------

function getSetting<T>(key: string, fallback: T): T {
  const row = db().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : fallback;
}

function setSetting(key: string, value: unknown) {
  db().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, JSON.stringify(value));
}

export const getZones = () => getSetting<Zone[]>("zones", DEFAULT_ZONES);
export const setZones = (z: Zone[]) => setSetting("zones", z);
export const getPhoneModel = () => getSetting<string>("phone_model", "Demo Phone");
export const setPhoneModel = (m: string) => setSetting("phone_model", m);
