import { getPhoneModel, getZones, setPhoneModel, setZones } from "@/lib/db";
import { requireConsent } from "@/lib/guard";
import type { Zone } from "@/lib/types";

export async function GET() {
  return Response.json({ zones: getZones(), phone_model: getPhoneModel() });
}

const inUnit = (n: unknown) => typeof n === "number" && n >= 0 && n <= 1;

export async function PUT(req: Request) {
  const denied = requireConsent(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as { zones?: Zone[]; phone_model?: string };
  if (body.zones) {
    const ok = Array.isArray(body.zones) && body.zones.every((z) =>
      typeof z.id === "string" && typeof z.name === "string" && z.name.length <= 60 &&
      inUnit(z.rect?.x) && inUnit(z.rect?.y) && inUnit(z.rect?.width) && inUnit(z.rect?.height));
    if (!ok) return Response.json({ error: "invalid zones" }, { status: 400 });
    setZones(body.zones);
  }
  if (body.phone_model !== undefined) {
    if (typeof body.phone_model !== "string" || body.phone_model.length > 60)
      return Response.json({ error: "invalid phone_model" }, { status: 400 });
    setPhoneModel(body.phone_model.trim());
  }
  return Response.json({ zones: getZones(), phone_model: getPhoneModel() });
}
