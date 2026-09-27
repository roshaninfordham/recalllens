import type { MemoryEvent, ObjectState } from "./types";
import { redact } from "./redact";

// Single place that talks to Cognee Cloud. Verified against Cognee 1.5.4:
//  - POST /api/v1/remember is multipart (raw_data); with session_id it returns in ~3s ("session_stored")
//    and Cognee merges it into the permanent graph in the background (~20s) with a data_id.
//  - POST /api/v1/recall with search_type CHUNKS returns the exact stored text + metadata.data_id (~4s).
//    Completion types paraphrase and drop timestamps, so we parse chunks ourselves.
//  - POST /api/v1/forget { dataset, dataId }.

const base = () => process.env.COGNEE_BASE_URL?.replace(/\/$/, "");
export const DATASET = () => process.env.COGNEE_DATASET || "personal_spatial_memory";
export const cogneeConfigured = () => Boolean(base() && process.env.COGNEE_API_KEY);

function headers(): Record<string, string> {
  const h: Record<string, string> = { "X-Api-Key": process.env.COGNEE_API_KEY ?? "" };
  if (process.env.COGNEE_TENANT_ID) h["X-Tenant-Id"] = process.env.COGNEE_TENANT_ID;
  return h;
}

async function call<T>(path: string, init: RequestInit, timeoutMs = 60_000): Promise<T> {
  if (!cogneeConfigured()) throw new Error("Cognee not configured (COGNEE_BASE_URL / COGNEE_API_KEY)");
  const res = await fetch(`${base()}${path}`, {
    ...init,
    headers: { ...headers(), ...(init.headers as Record<string, string>) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new Error("Cognee authentication failed");
  if (!res.ok) {
    const err = new Error(`Cognee ${path} ${res.status}: ${text.slice(0, 200)}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return (text ? JSON.parse(text) : null) as T;
}

/** Canonical, parseable text form of an observation. Keep field names stable: parseObservation depends on them. */
export function observationText(e: MemoryEvent): string {
  const lines = [
    "Observation:",
    `Object: ${e.label}`,
    `Object ID: ${e.object_id}`,
    e.previous_zone ? `Previous location: ${e.previous_zone}` : null,
    `Location zone: ${e.zone}`,
    `Timestamp: ${e.timestamp}`,
    `State: ${e.state}`,
    e.previous_state ? `Previous state: ${e.previous_state}` : null,
    e.damage_description ? `Damage description: ${e.damage_description}` : null,
    `Confidence: ${e.confidence.toFixed(2)}`,
    `Event: ${e.type.toLowerCase()}`,
    `Source: ${e.source}`,
  ];
  return redact(lines.filter(Boolean).join("\n"));
}

export interface RecalledObservation {
  object: string;
  object_id: string;
  zone: string;
  previous_zone?: string;
  timestamp: string;
  state: ObjectState;
  damage_description?: string;
  confidence: number;
  event: string;
  source: string;
  data_id?: string;
}

const FIELDS = ["Object ID", "Object", "Previous location", "Location zone", "Timestamp", "Previous state", "State", "Damage description", "Confidence", "Event", "Source"];
const FIELD_RE = new RegExp(`\\b(${FIELDS.join("|")}):`, "g");

/** Splits "Name: value" pairs regardless of whether Cognee kept newlines or joined them with ". ". */
function fields(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const hits = [...text.matchAll(FIELD_RE)];
  hits.forEach((m, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].index : text.length;
    out[m[1]] ??= text.slice(m.index + m[0].length, end).replace(/[\s.|]+$/, "").trim();
  });
  return out;
}

/** Parses one chunk back into a structured observation; null if it isn't one of ours. */
export function parseObservation(text: string, data_id?: string): RecalledObservation | null {
  const f = fields(text);
  const { "Object ID": object_id, Timestamp: timestamp, "Location zone": zone } = f;
  if (!object_id || !timestamp || !zone || Number.isNaN(Date.parse(timestamp))) return null;
  return {
    object: f.Object ?? object_id,
    object_id,
    zone,
    previous_zone: f["Previous location"],
    timestamp,
    state: (f.State ?? "uncertain") as ObjectState,
    damage_description: f["Damage description"],
    confidence: Number(f.Confidence ?? 0),
    event: f.Event ?? "observation",
    source: f.Source ?? "unknown",
    data_id,
  };
}

export async function rememberObservation(e: MemoryEvent, sessionId: string) {
  const form = new FormData();
  form.set("datasetName", DATASET());
  form.set("session_id", sessionId);
  form.set("self_improvement", "false");
  form.append("raw_data", observationText(e));
  return call<{ status: string; dataset_id?: string; items?: { id: string }[] }>("/api/v1/remember", { method: "POST", body: form });
}

interface RecallItem {
  text?: string;
  search_type?: string;
  metadata?: { data_id?: string };
}

/**
 * Structured recall: CHUNKS search, parse, keep only matching objects, newest first.
 * `category` is matched against object id and label (e.g. "charger").
 */
export async function recallObject(query: string, category?: string): Promise<RecalledObservation[]> {
  let items: RecallItem[] = [];
  try {
    items = await call<RecallItem[]>("/api/v1/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, datasets: [DATASET()], search_type: "CHUNKS", top_k: 25 }),
    });
  } catch (err) {
    // Empty/new dataset → 404 NoDataError; that's "no memory", not a failure.
    if ((err as { status?: number }).status === 404) return [];
    throw err;
  }
  const seen = new Set<string>();
  return (Array.isArray(items) ? items : [])
    .map((i) => (i.text ? parseObservation(i.text, i.metadata?.data_id) : null))
    .filter((o): o is RecalledObservation => {
      if (!o) return false;
      const key = `${o.object_id}|${o.timestamp}|${o.event}`; // session merge can duplicate a chunk
      if (seen.has(key)) return false;
      seen.add(key);
      const c = category?.toLowerCase();
      return !c || o.object_id.toLowerCase().includes(c) || o.object.toLowerCase().includes(c);
    })
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

/** Natural-language graph answer (slower, ~15s). Used for open-ended questions, not for "where is X". */
export async function recallAnswer(query: string, sessionId?: string): Promise<string | null> {
  try {
    const items = await call<RecallItem[]>(
      "/api/v1/recall",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, datasets: [DATASET()], session_id: sessionId, top_k: 10 }),
      },
      45_000,
    );
    return items?.map((i) => i.text).filter(Boolean).join("\n") || null;
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

export async function forgetObservation(dataId: string) {
  return call("/api/v1/forget", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataset: DATASET(), dataId }),
  });
}

export async function forgetDataset() {
  return call("/api/v1/forget", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataset: DATASET() }),
  });
}

export async function cogneeHealth(): Promise<{ ok: boolean; detail: string }> {
  if (!cogneeConfigured()) return { ok: false, detail: "not configured" };
  try {
    // /health is unauthenticated, so also hit an authed route to catch bad keys.
    await call("/api/v1/datasets/", { method: "GET" }, 10_000);
    return { ok: true, detail: "connected" };
  } catch (e) {
    return { ok: false, detail: (e as Error).message.slice(0, 120) };
  }
}
