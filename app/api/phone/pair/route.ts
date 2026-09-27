import { requireConsent } from "@/lib/guard";
import { bridgeStatus, endPairing, startPairing } from "@/lib/bridge";
import { publish } from "@/lib/bus";

export const dynamic = "force-dynamic";

/** Start (or restart) phone pairing: returns the one-time URL the QR code encodes. */
export async function POST(req: Request) {
  const denied = requireConsent(req);
  if (denied) return denied;
  try {
    const r = await startPairing();
    publish({ kind: "log", title: "PHONE PAIRING", detail: "Temporary public tunnel opened for the phone camera" });
    return Response.json(r);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}

export async function GET() {
  return Response.json(bridgeStatus());
}

export async function DELETE(req: Request) {
  const denied = requireConsent(req);
  if (denied) return denied;
  endPairing();
  publish({ kind: "log", title: "PHONE DISCONNECTED", detail: "Pairing ended" });
  return Response.json(bridgeStatus());
}
