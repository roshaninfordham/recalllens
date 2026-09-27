import { getConsent } from "./db";

/** Server-side consent gate: every data-bearing route requires a valid receipt id. */
export function requireConsent(req: Request): Response | null {
  const receipt = getConsent(req.headers.get("x-consent-id"));
  if (receipt?.choices.activity_recording && receipt.choices.cognee_memory_storage) return null;
  return Response.json({ error: "consent required" }, { status: 403 });
}
