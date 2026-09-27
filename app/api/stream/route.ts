import { recentMessages, subscribe } from "@/lib/bus";

export const dynamic = "force-dynamic";

/** Server-Sent Events: replays recent messages, then streams new ones. */
export async function GET(req: Request) {
  const enc = new TextEncoder();
  let unsubscribe = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (m: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(m)}\n\n`));
      for (const m of recentMessages()) send(m);
      unsubscribe = subscribe(send);
      const ping = setInterval(() => controller.enqueue(enc.encode(": ping\n\n")), 15_000);
      req.signal.addEventListener("abort", () => {
        clearInterval(ping);
        unsubscribe();
        controller.close();
      });
    },
    cancel: () => unsubscribe(),
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
