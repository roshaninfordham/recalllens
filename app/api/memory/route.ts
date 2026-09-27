import { requireConsent } from "@/lib/guard";
import { clearEvents, recentEvents } from "@/lib/db";
import { forgetDataset } from "@/lib/cognee";
import { pipe } from "@/lib/pipeline";
import { publish } from "@/lib/bus";

export async function GET() {
  return Response.json(recentEvents(50));
}

/** Forget everything: Cognee dataset + local mirror + tracker state. */
export async function DELETE(req: Request) {
  const denied = requireConsent(req);
  if (denied) return denied;
  let cognee = "ok";
  try {
    await forgetDataset();
  } catch (e) {
    cognee = (e as Error).message;
  }
  clearEvents();
  pipe.agg.reset();
  pipe.notified.clear();
  pipe.current = [];
  publish({ kind: "log", level: cognee === "ok" ? "ok" : "warn", title: "MEMORY CLEARED", detail: `cognee: ${cognee}` });
  return Response.json({ cleared: true, cognee });
}
