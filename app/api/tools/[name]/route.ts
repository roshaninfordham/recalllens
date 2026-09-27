import { TOOLS, runTool } from "@/lib/tools";
import { pipe, sessionId } from "@/lib/pipeline";

// Tool endpoints for ClawMax/OpenClaw skills (they `curl` these). Loopback only: npm scripts bind to 127.0.0.1,
// and the Host check blocks DNS-rebinding from a browser tab.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export async function GET() {
  return Response.json(Object.fromEntries(Object.entries(TOOLS).map(([k, t]) => [k, { description: t.description, parameters: t.parameters }])));
}

export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }) {
  if (!LOCAL_HOST.test(req.headers.get("host") ?? "")) return Response.json({ error: "loopback only" }, { status: 403 });
  if (!pipe.consentId) return Response.json({ error: "no consented session active; open RecallLens and accept consent first" }, { status: 403 });
  const { name } = await ctx.params;
  if (!TOOLS[name]) return Response.json({ error: `unknown tool ${name}` }, { status: 404 });
  const args = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    return Response.json(await runTool(name, args, { sessionId: sessionId(pipe.consentId), via: "clawmax-skill" }));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
