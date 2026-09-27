import { readFileSync } from "node:fs";
import { join } from "node:path";
import { publish } from "./bus";
import { TOOLS, runTool } from "./tools";
import { ensureBridge, issueTurnToken, revokeTurnToken } from "./bridge";

// Memory Concierge runtime.
//  - "clawmax": ClawMax chat API (POST /api/agents/:id/chat, SSE). The ClawMax agent runs the skills in clawmax/,
//    which curl /api/tools/* — so its tool calls still show up in the UI.
//  - "local": same instructions + same tools, run here via OpenAI-compatible tool calling on the ClawMax-issued key.

export type AgentMode = "clawmax" | "local" | "none";

export function agentMode(): AgentMode {
  if (process.env.CLAWMAX_BASE_URL) return "clawmax";
  if (process.env.OPENAI_API_KEY || process.env.AGENT_API_KEY) return "local";
  return "none";
}

const SOUL = () => readFileSync(join(process.cwd(), "clawmax/AGENTS/memory-concierge/SOUL.md"), "utf8");

type Msg = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

const g = globalThis as unknown as { __rlHistory?: Map<string, Msg[]> };
const histories = (g.__rlHistory ??= new Map());

/** Forget the local runtime's conversation context (used by "forget all memory"). */
export const clearHistories = () => histories.clear();

export async function askAgent(message: string, sessionId: string, lang: string): Promise<{ reply: string; mode: AgentMode; ms: number }> {
  const mode = agentMode();
  const t0 = Date.now();
  publish({ kind: "agent", title: "USER", detail: message, data: { lang } });
  if (mode === "none") throw new Error("No agent runtime configured (set CLAWMAX_BASE_URL or OPENAI_API_KEY)");
  let used: AgentMode = mode;
  let reply: string;
  if (mode === "clawmax") {
    try {
      reply = await viaClawMax(message, sessionId, lang);
    } catch (e) {
      // Degrade honestly: say ClawMax failed and that the local runtime answered instead.
      const canLocal = Boolean(process.env.OPENAI_API_KEY || process.env.AGENT_API_KEY);
      publish({ kind: "agent", level: "warn", title: "CLAWMAX UNAVAILABLE", detail: `${(e as Error).message.slice(0, 120)}${canLocal ? " · answering with the local runtime" : ""}` });
      if (!canLocal) throw e;
      used = "local";
      reply = await viaLocal(message, sessionId, lang);
    }
  } else {
    reply = await viaLocal(message, sessionId, lang);
  }
  publish({ kind: "agent", level: "ok", title: "AGENT", detail: reply, data: { mode: used, ms: Date.now() - t0 } });
  return { reply, mode: used, ms: Date.now() - t0 };
}

// A ClawMax session that failed once (e.g. a provider auth error) can stay stuck, so a failure rotates it.
// A per-start suffix also gives each server start fresh ClawMax sessions (RecallLens's own memory is in Cognee).
const gs = globalThis as unknown as { __rlClawmaxGen?: Map<string, number>; __rlBoot?: string };
const sessionGen = (gs.__rlClawmaxGen ??= new Map());
const boot = (gs.__rlBoot ??= Date.now().toString(36));

async function viaClawMax(message: string, sessionId: string, lang: string): Promise<string> {
  const id = process.env.CLAWMAX_AGENT_ID || "memory-concierge";
  publish({ kind: "agent", title: "CLAWMAX", detail: `Sent to ClawMax agent “${id}” (hosted; replies take about 1–2 minutes)` });
  // The hosted agent reaches RecallLens's tools through the bridge with a token valid for this turn only.
  const toolsUrl = `${await ensureBridge()}/tools`;
  const token = issueTurnToken(sessionId);
  const gen = sessionGen.get(sessionId) ?? 0;
  try {
    return await clawmaxTurn(id, `[RecallLens tools: ${toolsUrl} · turn token: ${token} (valid for this reply only) · user language: ${lang}]\n${message}`, `${sessionId}-${boot}-${gen}`);
  } catch (e) {
    sessionGen.set(sessionId, gen + 1);
    throw e;
  } finally {
    revokeTurnToken(token);
  }
}

async function clawmaxTurn(id: string, message: string, sessionId: string): Promise<string> {
  const res = await fetch(`${process.env.CLAWMAX_BASE_URL!.replace(/\/$/, "")}/api/agents/${id}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.CLAWMAX_DASHBOARD_TOKEN ? { Authorization: `Bearer ${process.env.CLAWMAX_DASHBOARD_TOKEN}` } : {}),
    },
    // Hosted instances keep model keys browser-local, so the key travels per request (HTTPS, never in the prompt).
    // It goes as an "OpenAI-compatible" provider: that path uses Chat Completions, which restricted project keys
    // allow; the native "openai" provider uses the Responses API and fails without the api.responses.write scope.
    body: JSON.stringify({
      message, sessionId,
      ...(process.env.CLAWMAX_BYOK_OPENAI === "1" && process.env.OPENAI_API_KEY
        ? { byok: { openaiCompatibleBaseUrl: "https://api.openai.com/v1", openaiCompatibleApiKey: process.env.OPENAI_API_KEY, openaiCompatibleDefaultModel: "gpt-4.1" } }
        : {}),
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok || !res.body) throw new Error(`ClawMax chat ${res.status}: ${(await res.text()).slice(0, 160)}`);
  // SSE: data: {"type":"start|delta|complete|error","data":{...}}. Only "complete" counts as success.
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const ev = JSON.parse(line.slice(5).trim() || "{}");
      if (ev.type === "delta") text += ev.data?.text ?? "";
      if (ev.type === "error") throw new Error(`ClawMax agent error: ${JSON.stringify(ev.data).slice(0, 160)}`);
      if (ev.type === "complete") return ev.data?.text || text;
    }
  }
  throw new Error("ClawMax stream ended without completing");
}

const toolSpecs = () =>
  Object.entries(TOOLS).map(([name, t]) => ({ type: "function", function: { name, description: t.description, parameters: t.parameters } }));

async function viaLocal(message: string, sessionId: string, lang: string): Promise<string> {
  const history = histories.get(sessionId) ?? [];
  const msgs: Msg[] = [
    { role: "system", content: `${SOUL()}\n\nThe user's selected speech language is ${lang}. Current time: ${new Date().toISOString()}.` },
    ...history,
    { role: "user", content: message },
  ];
  const base = (process.env.AGENT_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const key = process.env.AGENT_API_KEY || process.env.OPENAI_API_KEY;

  for (let step = 0; step < 8; step++) {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: process.env.AGENT_MODEL || "gpt-4.1", temperature: 0.2, messages: msgs, tools: toolSpecs() }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`agent model ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const choice = (await res.json()).choices?.[0]?.message as Msg;
    msgs.push({ role: "assistant", content: choice.content ?? null, tool_calls: choice.tool_calls });
    if (!choice.tool_calls?.length) {
      const reply = choice.content?.trim() || "(no reply)";
      histories.set(sessionId, [...history, { role: "user", content: message }, { role: "assistant", content: reply }].slice(-12));
      return reply;
    }
    for (const call of choice.tool_calls) {
      let result: unknown;
      try {
        result = await runTool(call.function.name, JSON.parse(call.function.arguments || "{}"), { sessionId, via: "local-runtime" });
      } catch (e) {
        result = { error: (e as Error).message };
      }
      msgs.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  throw new Error("agent exceeded 8 tool steps");
}
