import type { BBox, Detection, ObjectState, Proposal } from "./types";

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

// Boxes are 0–1 floats: on the eval set they beat [ymin,xmin,ymax,xmax] 0–1000 integers on recall and naming.
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
        required: ["mark", "label", "confidence", "box", "state", "state_confidence", "damage_description"],
        properties: {
          mark: { type: "integer" },
          label: { type: "string" },
          confidence: { type: "number" },
          box: {
            type: "object", additionalProperties: false, required: ["x", "y", "width", "height"],
            properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } },
          },
          state: { type: "string", enum: STATES },
          state_confidence: { type: "number" },
          damage_description: { type: "string" },
        },
      },
    },
  },
};

function prompt(proposals: Proposal[]) {
  const marks = proposals.length
    ? `The image has numbered boxes from a fast on-device detector. Those boxes are precise, but the detector only knows generic classes and is often wrong about what the object is (a charger brick may be called "cell phone", "remote" or "mouse"). Its guesses:
${proposals.map((p) => `#${p.mark} "${p.label}" (${p.score.toFixed(2)})`).join("\n")}
Every numbered box that contains a real object must appear exactly once: set mark to that number and box to {x:0,y:0,width:0,height:0} (the numbered box is used). Look closely at what is inside each box before naming it. Leave out only boxes that contain no real object or a person/furniture.
For an object with no numbered box, set mark to 0 and give a tight box.`
    : "There are no numbered boxes: set mark to 0 for every object and give a tight box.";
  return `You are the perception layer of a personal memory assistant. Detect every distinct physical object a person could pick up, carry, use or misplace: phones, chargers and cables, keys, wallets, glasses, earbuds and headphones, bottles, cups and mugs, books and notebooks, pens, remotes, tools, bags, toys, food, electronics, clothing accessories, and anything being held in a hand.
Skip people, body parts, faces, walls, floors, windows, large furniture and fixtures. Never read or transcribe text or screen contents.

${marks}

For each object:
- label: name the object itself (the container, not what is in it: "bowl of peas", not "peas"), as specifically as you are confident, 1-4 words (e.g. "white USB-C charger", "black ceramic mug", "TV remote", "house keys").
- confidence 0-1 that it really is that object.
- box: {x, y, width, height} normalized 0-1, x,y = top-left. Tight: edges touch the object's visible extremes.
- state: "damaged" if ANY physical damage is visible (connector separated or pulled away from its cable, exposed or frayed wires, split insulation, cracked or broken housing or screen, bent prongs, burn marks, torn or shattered parts); "normal" if it looks intact; "uncertain" if you can't tell. Inspect cables and connectors closely.
- state_confidence 0-1; damage_description: brief if damaged, else "".
List at most 12 objects, most prominent first. If there are none return {"objects":[]}. Output JSON only.`;
}

const clamp = (n: unknown) => Math.min(1, Math.max(0, Number(n) || 0));

function toBBox(box: unknown): BBox | null {
  if (!box || typeof box !== "object") return null;
  const b = box as Record<string, unknown>;
  const r = { x: clamp(b.x), y: clamp(b.y), width: clamp(b.width), height: clamp(b.height) };
  r.width = Math.min(r.width, 1 - r.x);
  r.height = Math.min(r.height, 1 - r.y);
  return r.width > 0.005 && r.height > 0.005 ? r : null;
}

/** Fixtures and furniture are never "things you misplace"; the model lists them despite the prompt, so filter here. */
const FIXTURE = /\b(table|desk|shelf|shelves|bookshelf|bookcase|cabinet|cupboard|drawers?|dresser|chair|sofa|couch|bed|window|door|wall|floor|ceiling|curtains?|rug|carpet|radiator|fireplace|counter(top)?|staircase|stairs)\b/i;

/** Proposals the model skipped are kept only when the detector is this sure (it rarely hallucinates at high scores). */
const KEEP_UNNAMED = 0.6;

/**
 * Validates untrusted model output and merges it with the detector's proposals: an object on a numbered box takes
 * that precise box; an object with mark 0 keeps the model's approximate box. Malformed entries are dropped.
 */
export function parseDetections(raw: string, proposals: Proposal[] = []): Detection[] {
  const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  let parsed: { objects?: unknown[] };
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("vision returned malformed JSON");
  }
  const byMark = new Map(proposals.map((p) => [p.mark, p]));
  const used = new Set<number>();
  const out: Detection[] = [];
  for (const o of Array.isArray(parsed.objects) ? parsed.objects : []) {
    const d = o as Record<string, unknown>;
    if (typeof d.label !== "string" || FIXTURE.test(d.label)) continue;
    const proposal = byMark.get(Number(d.mark));
    if (proposal && used.has(proposal.mark)) continue;
    const bbox = proposal ? proposal.bbox : toBBox(d.box);
    if (!bbox) continue;
    if (proposal) used.add(proposal.mark);
    out.push({
      label: d.label.slice(0, 60),
      confidence: clamp(d.confidence),
      bbox,
      state: STATES.includes(d.state as ObjectState) ? (d.state as ObjectState) : "uncertain",
      state_confidence: clamp(d.state_confidence),
      damage_description: typeof d.damage_description === "string" && d.damage_description ? d.damage_description.slice(0, 140) : undefined,
      box_source: proposal ? "detector" : "vision",
    });
  }
  for (const p of proposals) {
    if (used.has(p.mark) || p.score < KEEP_UNNAMED) continue;
    out.push({ label: p.label, confidence: p.score, bbox: p.bbox, state: "uncertain", state_confidence: 0, box_source: "detector" });
  }
  return out;
}

/** Validates proposals from the browser (untrusted input). */
export function sanitizeProposals(input: unknown): Proposal[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 20).flatMap((p, i) => {
    const r = p as Record<string, unknown>;
    const bbox = toBBox(r.bbox);
    if (!bbox || typeof r.label !== "string") return [];
    return [{ mark: Number.isInteger(r.mark) ? Number(r.mark) : i + 1, label: r.label.slice(0, 40), score: clamp(r.score), bbox }];
  });
}

export async function analyzeFrame(imageDataUrl: string, proposals: Proposal[] = []) {
  const cfg = visionConfig();
  if (cfg.mode === "none") throw new Error("No vision provider configured");
  const t0 = Date.now();
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}) },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      max_tokens: 1200,
      ...(cfg.mode === "openai" ? { response_format: { type: "json_schema", json_schema: { name: "detections", strict: true, schema: SCHEMA } } } : {}),
      messages: [
        { role: "system", content: prompt(proposals) },
        { role: "user", content: [{ type: "image_url", image_url: { url: imageDataUrl, detail: process.env.VISION_DETAIL ?? "low" } }] },
      ],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`vision ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const body = await res.json();
  const detections = parseDetections(body.choices?.[0]?.message?.content ?? "", proposals);
  return { detections, mode: cfg.mode, model: cfg.model, latency_ms: Date.now() - t0 };
}
