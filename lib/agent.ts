import { readFileSync } from "node:fs";
import { join } from "node:path";
import { publish } from "./bus";
import { TOOLS, runTool } from "./tools";

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
  const reply = mode === "clawmax" ? await viaClawMax(message, sessionId, lang) : await viaLocal(message, sessionId, lang);
  publish({ kind: "agent", level: "ok", title: "AGENT", detail: reply, data: { mode, ms: Date.now() - t0 } });
  return { reply, mode, ms: Date.now() - t0 };
}

async function viaClawMax(message: string, sessionId: string, lang: string): Promise<string> {
  const id = process.env.CLAWMAX_AGENT_ID || "memory-concierge";
  const res = await fetch(`${process.env.CLAWMAX_BASE_URL!.replace(/\/$/, "")}/api/agents/${id}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.CLAWMAX_DASHBOARD_TOKEN ? { Authorization: `Bearer ${process.env.CLAWMAX_DASHBOARD_TOKEN}` } : {}),
    },
    body: JSON.stringify({ message: `[user language: ${lang}] ${message}`, sessionId }),
    signal: AbortSignal.timeout(120_000),
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
