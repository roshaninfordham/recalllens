import { publish } from "./bus";
import { forgetObservation, recallObject, rememberObservation } from "./cognee";
import { band, latestTrustworthy } from "./confidence";
import { addCart, getCart, getPhoneModel, getZones, recentEvents } from "./db";
import { demoCatalog } from "./commerce";
import { pipe } from "./pipeline";
import { categoryOf } from "./aggregator";
import { zoneName } from "./zones";

// The Memory Concierge's tools. Exposed at /api/tools/<name> (for ClawMax/OpenClaw skills via curl)
// and called in-process by the local agent runtime. Each call is published so the UI shows real execution.


interface Tool {
  description: string;
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: { sessionId: string }): Promise<unknown>;
}

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required, additionalProperties: false });

export const TOOLS: Record<string, Tool> = {
  recall_object: {
    description: "Search long-term memory (Cognee) for where an object was last seen. Returns the newest trustworthy observation with zone, timestamp, state, confidence band and age.",
    parameters: obj({ object: { type: "string", description: "e.g. 'charger', 'keys'" } }, ["object"]),
    async run(a) {
      const object = str(a.object, 60);
      const category = categoryOf(object);
      const history = await recallObject(`most recent observation of the user's ${object}: location zone, timestamp, state`, category);
      const last = latestTrustworthy(history);
      const zones = getZones();
      return {
        object,
        found: Boolean(last),
        last_seen: last && {
          zone: last.zone,
          zone_name: zoneName(last.zone, zones),
          timestamp: last.timestamp,
          age_seconds: Math.round((Date.now() - Date.parse(last.timestamp)) / 1000),
          state: last.state,
          damage_description: last.damage_description,
          confidence: last.confidence,
          confidence_band: band(last.confidence),
        },
        observations_found: history.length,
        history: history.slice(0, 5).map((o) => ({ zone: o.zone, timestamp: o.timestamp, state: o.state, event: o.event, confidence: o.confidence })),
      };
    },
  },
  recall_recent_events: {
    description: "List the most recent memory events (what changed recently), newest first.",
    parameters: obj({ limit: { type: "number" } }),
    async run(a) {
      const n = Math.min(20, Math.max(1, Number(a.limit) || 8));
      return recentEvents(n).map(({ type, label, zone, state, timestamp, confidence, cognee_status }) => ({ type, label, zone, state, timestamp, confidence, cognee_status }));
    },
  },
  current_view: {
    description: "What the camera sees right now (live, not memory). Use to confirm whether an object is currently visible.",
    parameters: obj({}),
    async run() {
      return {
        last_frame_at: pipe.lastFrameAt ?? null,
        objects: pipe.current.map((d) => ({ object_id: d.object_id, label: d.label, zone: d.zone, state: d.state, confidence: d.confidence })),
      };
    },
  },
  remember_observation: {
    description: "Store something the user explicitly told you about an object's location (e.g. 'I put my keys in the drawer'). Never store secrets or sensitive data.",
    parameters: obj({ object: { type: "string" }, zone: { type: "string" }, note: { type: "string" } }, ["object", "zone"]),
    async run(a, ctx) {
      const label = str(a.object, 60);
      const r = await rememberObservation({
        type: "FIRST_SEEN", object_id: `${categoryOf(label)}-user`, label, zone: str(a.zone, 60),
        state: "normal", confidence: 0.8, timestamp: new Date().toISOString(), source: "user_told",
      }, ctx.sessionId);
      return { stored: true, status: r.status };
    },
  },
  forget_memory: {
    description: "Delete one stored observation from long-term memory by its data_id.",
    parameters: obj({ data_id: { type: "string" } }, ["data_id"]),
    async run(a) {
      return forgetObservation(str(a.data_id, 64));
    },
  },
  get_user_profile: {
    description: "The user's configured devices (phone model) for compatibility checks.",
    parameters: obj({}),
    async run() {
      return { phone_model: getPhoneModel() };
    },
  },
  search_products: {
    description: "Search the product catalog. Pass the user's phone model as compatibility to get only compatible items.",
    parameters: obj({ query: { type: "string" }, compatibility: { type: "string" } }, ["query"]),
    async run(a) {
      const hits = await demoCatalog.searchProducts(str(a.query), str(a.compatibility, 60) || undefined);
      return hits.slice(0, 5);
    },
  },
  add_to_cart: {
    description: "Add a product to the demo cart. This does NOT purchase anything. Only call after the user asked for a replacement/purchase help.",
    parameters: obj({ product_id: { type: "string" } }, ["product_id"]),
    async run(a) {
      const p = await demoCatalog.getProduct(str(a.product_id, 64));
      if (!p) return { success: false, error: "unknown product_id" };
      addCart(p.id, "RecallLens Agent");
      publish({ kind: "cart", title: "ADDED TO CART", detail: p.name, data: getCart() });
      return { success: true, product: { id: p.id, name: p.name, price: p.price }, note: "Added to cart. Nothing was purchased." };
    },
  },
};

export async function runTool(name: string, args: Record<string, unknown>, ctx: { sessionId: string; via: string }) {
  const tool = TOOLS[name];
  if (!tool) throw new Error(`unknown tool ${name}`);
  const t0 = Date.now();
  publish({ kind: "agent", title: "TOOL CALL", detail: `${name}(${JSON.stringify(args)})`, data: { tool: name, args, via: ctx.via } });
  try {
    const result = await tool.run(args, ctx);
    publish({ kind: "agent", level: "ok", title: "TOOL RESULT", detail: `${name} ✓ ${Date.now() - t0}ms`, data: { tool: name, result } });
    return result;
  } catch (e) {
    publish({ kind: "agent", level: "error", title: "TOOL FAILED", detail: `${name}: ${(e as Error).message}`, data: { tool: name } });
    throw e;
  }
}
