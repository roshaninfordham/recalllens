import { cogneeHealth, cogneeConfigured } from "@/lib/cognee";
import { agentMode } from "@/lib/agent";
import { visionConfig } from "@/lib/vision";
import { demoCatalog } from "@/lib/commerce";

export const dynamic = "force-dynamic";

async function clawmaxHealth() {
  const mode = agentMode();
  if (mode !== "clawmax") return { ok: false, agent: mode === "local", mode, detail: mode === "local" ? "workspace not connected · agent runs locally on ClawMax-issued key" : "not configured" };
  try {
    const r = await fetch(`${process.env.CLAWMAX_BASE_URL!.replace(/\/$/, "")}/api/agents`, {
      headers: process.env.CLAWMAX_DASHBOARD_TOKEN ? { Authorization: `Bearer ${process.env.CLAWMAX_DASHBOARD_TOKEN}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    const local = Boolean(process.env.OPENAI_API_KEY || process.env.AGENT_API_KEY);
    return { ok: r.ok, agent: r.ok || local, mode: r.ok ? mode : local ? "local" : mode, detail: r.ok ? "connected" : `HTTP ${r.status}${r.status === 401 ? " (credential rejected)" : ""}${local ? " · agent falls back to local runtime" : ""}` };
  } catch (e) {
    const local = Boolean(process.env.OPENAI_API_KEY || process.env.AGENT_API_KEY);
    return { ok: false, agent: local, mode: local ? "local" : mode, detail: (e as Error).message };
  }
}

/** Server-side component health. Camera and voice are browser capabilities and are reported by the client. */
export async function GET() {
  const [cognee, clawmax, products] = await Promise.all([
    cogneeHealth(),
    clawmaxHealth(),
    demoCatalog.searchProducts("charger").then((p) => p.length > 0, () => false),
  ]);
  const v = visionConfig();
  return Response.json({
    cognee: cognee.ok, clawmax: clawmax.ok, agent: clawmax.agent, vision: v.mode !== "none", commerce: products,
    detail: {
      cognee: cogneeConfigured() ? cognee.detail : "not configured",
      clawmax: clawmax.detail, agent_mode: clawmax.mode,
      vision: v.mode === "none" ? "no provider" : `${v.mode} · ${v.model}`,
    },
  });
}
