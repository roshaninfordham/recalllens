import { requireConsent } from "@/lib/guard";
import { askAgent } from "@/lib/agent";
import { pipe, sessionId } from "@/lib/pipeline";
import { redact } from "@/lib/redact";
import { publish } from "@/lib/bus";

export async function POST(req: Request) {
  const denied = requireConsent(req);
  if (denied) return denied;
  const { message, lang } = (await req.json().catch(() => ({}))) as { message?: string; lang?: string };
  if (typeof message !== "string" || !message.trim() || message.length > 1000)
    return Response.json({ error: "message required (max 1000 chars)" }, { status: 400 });
  const consentId = req.headers.get("x-consent-id")!;
  pipe.consentId = consentId;
  try {
    return Response.json(await askAgent(redact(message.trim()), sessionId(consentId), typeof lang === "string" ? lang.slice(0, 20) : "en-US"));
  } catch (e) {
    const msg = (e as Error).message;
    publish({ kind: "agent", level: "error", title: "AGENT ERROR", detail: msg });
    return Response.json({ error: msg }, { status: 502 });
  }
}
