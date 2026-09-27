// Installs RecallLens's Memory Concierge on a ClawMax instance: creates/updates the cognee-memory and
// personal-commerce skills, provisions the memory-concierge agent from clawmax/AGENTS, and assigns the skills.
// Idempotent. Usage: npm run clawmax:setup   (needs CLAWMAX_BASE_URL + CLAWMAX_DASHBOARD_TOKEN in .env.local)
import { readFileSync } from "node:fs";

const BASE = process.env.CLAWMAX_BASE_URL?.replace(/\/$/, "");
const TOKEN = process.env.CLAWMAX_DASHBOARD_TOKEN;
if (!BASE || !TOKEN) throw new Error("Set CLAWMAX_BASE_URL and CLAWMAX_DASHBOARD_TOKEN in .env.local");
const AGENT = process.env.CLAWMAX_AGENT_ID || "memory-concierge";
// "openai-compatible" rather than "openai": OpenClaw's native OpenAI provider calls the Responses API, which
// restricted project keys (like the hackathon key) reject; the compatible provider uses Chat Completions.
const MODEL = process.env.CLAWMAX_AGENT_MODEL || "openai-compatible/gpt-4.1";
const SKILLS = ["cognee-memory", "personal-commerce"];

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text;
}
const list = (text: string) => {
  const d = JSON.parse(text);
  return (Array.isArray(d) ? d : Object.values(d).find(Array.isArray) ?? []) as Record<string, string>[];
};

/** Splits a SKILL.md into its frontmatter fields and markdown body. */
function readSkill(name: string) {
  const raw = readFileSync(`clawmax/SKILLS/custom/${name}/SKILL.md`, "utf8");
  const [, fm, body] = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/) ?? [];
  const field = (k: string) => fm.match(new RegExp(`^${k}:\\s*(.+)$`, "m"))?.[1].trim() ?? "";
  const tags = field("tags").replace(/[[\]]/g, "").split(",").map((t) => t.trim()).filter(Boolean);
  return { description: field("description"), tags, content: body.trim() + "\n" };
}

const existingSkills = new Set(list(await call("GET", "/api/skills")).map((s) => s.name));
for (const name of SKILLS) {
  const s = readSkill(name);
  if (existingSkills.has(name)) {
    await call("PUT", `/api/skills/${name}/content`, { content: s.content, description: s.description, tags: s.tags });
    console.log(`skill ${name}: updated`);
  } else {
    await call("POST", "/api/skills", { name, description: s.description, tags: s.tags, requires: { bins: ["curl"] }, content: s.content });
    console.log(`skill ${name}: created`);
  }
}

const agents = list(await call("GET", "/api/agents")).map((a) => a.id);
if (agents.includes(AGENT)) {
  await call("PATCH", `/api/agents/${AGENT}/model`, { model: MODEL });
  console.log(`agent ${AGENT}: already exists · model set to ${MODEL}`);
} else {
  const dir = "clawmax/AGENTS/memory-concierge";
  const stream = await call("POST", "/api/agents/provision", {
    name: AGENT,
    model: MODEL,
    tags: ["recalllens"],
    aiDescription: "Personal spatial memory assistant for RecallLens",
    skills: SKILLS,
    generatedFiles: {
      identity: readFileSync(`${dir}/IDENTITY.md`, "utf8"),
      soul: readFileSync(`${dir}/SOUL.md`, "utf8"),
      tools: readFileSync(`${dir}/TOOLS.md`, "utf8"),
    },
  });
  // Provisioning streams progress as SSE; surface its last lines and any error.
  const events = stream.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
  const failed = events.find((e) => /"type":"error"|"error":/.test(e));
  console.log(`agent ${AGENT}: provisioned (${MODEL})\n  ${events.slice(-3).join("\n  ")}`);
  if (failed) throw new Error(`provisioning reported an error: ${failed.slice(0, 300)}`);
}

await call("PUT", `/api/skills/agent/${AGENT}`, { skills: SKILLS });
console.log(`agent ${AGENT}: skills assigned → ${SKILLS.join(", ")}`);
