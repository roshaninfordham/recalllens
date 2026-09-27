import { POLICY_VERSION, getConsent, saveConsent, validateConsent } from "@/lib/db";

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  const receipt = getConsent(id);
  return Response.json({ policy_version: POLICY_VERSION, receipt }, { status: id && !receipt ? 404 : 200 });
}

export async function POST(req: Request) {
  const v = validateConsent(await req.json().catch(() => null));
  if (!v.ok) return Response.json({ error: v.error }, { status: 400 });
  return Response.json(saveConsent(v.participant_id, v.choices), { status: 201 });
}
