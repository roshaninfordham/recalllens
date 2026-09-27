import { requireConsent } from "@/lib/guard";
import { latestFrame } from "@/lib/bridge";

export const dynamic = "force-dynamic";

/** Latest phone frame for the laptop page (kept in memory only). 204 until the phone sends one. */
export async function GET(req: Request) {
  const denied = requireConsent(req);
  if (denied) return denied;
  const f = latestFrame();
  if (!f) return new Response(null, { status: 204 });
  return new Response(new Uint8Array(f.frame), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store", "X-Frame-At": String(f.at) } });
}
