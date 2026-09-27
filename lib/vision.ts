import type { Detection, ObjectState, Zone } from "./types";

// One OpenAI-compatible chat-completions call per sampled frame.
// Modes (VISION_MODE): "openclaw" = OpenClaw gateway's /v1/chat/completions (reuses the agent's configured model),
// "openai" = any OpenAI-compatible endpoint (OpenAI, Gemini compat, local Ollama). "auto" picks openclaw if configured.

export type VisionMode = "openclaw" | "openai" | "none";

export function visionConfig(): { mode: VisionMode; url: string; key: string; model: string } {
  const want = process.env.VISION_MODE ?? "auto";
  const gw = process.env.OPENCLAW_GATEWAY_URL;
  if ((want === "openclaw" || want === "auto") && gw && process.env.OPENCLAW_GATEWAY_TOKEN)
    return { mode: "openclaw", url: `${gw.replace(/\/$/, "")}/v1/chat/completions`, key: process.env.OPENCLAW_GATEWAY_TOKEN, model: "openclaw/default" };
  const key = process.env.VISION_API_KEY || process.env.OPENAI_API_KEY || "";
  const baseUrl = (process.env.VISION_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const local = /localhost|127\.0\.0\.1/.test(baseUrl);
  if (want !== "openclaw" && (key || local))
    return { mode: "openai", url: `${baseUrl}/chat/completions`, key, model: process.env.VISION_MODEL || "gpt-4.1" };
  return { mode: "none", url: "", key: "", model: "" };
}

const STATES: ObjectState[] = ["normal", "damaged", "missing", "moving", "uncertain"];

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["objects"],
  properties: {
    objects: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "confidence", "bbox", "zone_id", "state", "state_confidence", "damage_description"],
        properties: {
          label: { type: "string" },
          confidence: { type: "number" },
          bbox: {
            type: "object", additionalProperties: false, required: ["x", "y", "width", "height"],
            properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } },
          },
          zone_id: { type: "string" },
          state: { type: "string", enum: STATES },
          state_confidence: { type: "number" },
          damage_description: { type: "string" },
        },
      },
    },
  },
};

function prompt(zones: Zone[]) {
  const zoneList = zones.map((z) => `- ${z.id} ("${z.name}"): x ${z.rect.x.toFixed(2)}-${(z.rect.x + z.rect.width).toFixed(2)}, y ${z.rect.y.toFixed(2)}-${(z.rect.y + z.rect.height).toFixed(2)}`).join("\n");
  return `You are the perception layer of a personal memory assistant. Report ONLY these everyday personal items if clearly visible: phone chargers (wall adapters, charging bricks, charging cables), keys, wallets, glasses, phones.
Ignore people, faces, screens' contents, documents and any text; never transcribe text.

For each item return:
- label: short generic name, e.g. "USB-C phone charger", "house keys".
- confidence 0-1 that the item is really that object.
- bbox: normalized 0-1 box (x,y = top-left, relative to full image width/height). Be as tight as you can.
- zone_id: which labeled zone the item's centre is in. The zones are drawn on the image as labelled rectangles and are:
${zoneList}
  Use "unmapped-area" if none fits.
- state: inspect each charger's cable and connectors closely before deciding. "damaged" if ANY physical damage is visible: a connector separated or pulled away from its cable, exposed or frayed wires, split or stripped insulation, cracked or broken housing, bent prongs, burn marks. "normal" only if the cable and connectors look intact. "uncertain" if you can't tell.
- state_confidence 0-1, damage_description: brief if damaged, else "".
If none of these items are visible return {"objects":[]}. Output JSON only.`;
}

const clamp = (n: unknown) => Math.min(1, Math.max(0, Number(n) || 0));

/** Validates untrusted model output into Detections; drops malformed entries instead of failing the frame. */
export function parseDetections(raw: string, zones: Zone[]): Detection[] {
  const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  let parsed: { objects?: unknown[] };
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("vision returned malformed JSON");
  }
  const zoneIds = new Set(zones.map((z) => z.id));
  return (Array.isArray(parsed.objects) ? parsed.objects : []).flatMap((o) => {
    const d = o as Record<string, unknown> & { bbox?: Record<string, unknown> };
    if (typeof d.label !== "string" || !d.bbox) return [];
    const state = STATES.includes(d.state as ObjectState) ? (d.state as ObjectState) : "uncertain";
    const bbox = { x: clamp(d.bbox.x), y: clamp(d.bbox.y), width: clamp(d.bbox.width), height: clamp(d.bbox.height) };
    return [{
      label: d.label.slice(0, 60),
      confidence: clamp(d.confidence),
      bbox,
      state,
      state_confidence: clamp(d.state_confidence),
      damage_description: typeof d.damage_description === "string" && d.damage_description ? d.damage_description.slice(0, 140) : undefined,
      zone_hint: typeof d.zone_id === "string" && zoneIds.has(d.zone_id) ? d.zone_id : undefined,
    }];
  });
}

export async function analyzeFrame(imageDataUrl: string, zones: Zone[]) {
  const cfg = visionConfig();
  if (cfg.mode === "none") throw new Error("No vision provider configured");
  const t0 = Date.now();
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}) },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      max_tokens: 600,
      ...(cfg.mode === "openai" ? { response_format: { type: "json_schema", json_schema: { name: "detections", strict: true, schema: SCHEMA } } } : {}),
      messages: [
        { role: "system", content: prompt(zones) },
        { role: "user", content: [{ type: "image_url", image_url: { url: imageDataUrl, detail: process.env.VISION_DETAIL ?? "low" } }] },
      ],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`vision ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const body = await res.json();
  const detections = parseDetections(body.choices?.[0]?.message?.content ?? "", zones);
  return { detections, mode: cfg.mode, model: cfg.model, latency_ms: Date.now() - t0 };
}
