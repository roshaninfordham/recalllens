"use client";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { BusMessage } from "@/lib/bus";
import type { StoredEvent } from "@/lib/db";
import type { Zone } from "@/lib/types";
import { ago, time } from "@/lib/client";

const EVENT_TEXT: Record<StoredEvent["type"], string> = {
  FIRST_SEEN: "First seen", MOVED: "Moved", STATE_CHANGED: "State changed", REAPPEARED: "Reappeared", DISAPPEARED: "No longer visible",
};
const COGNEE_TEXT: Record<StoredEvent["cognee_status"], string> = {
  pending: "Saving to Cognee…", stored: "In Cognee", failed: "Cognee write failed", skipped: "Not stored (transient)",
};

export function MemoryPanel({ messages, zones }: { messages: BusMessage[]; zones: Zone[] }) {
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [, tick] = useState(0);
  const memoryMsgs = messages.filter((m) => m.kind === "memory" || m.title.startsWith("COGNEE") || m.title === "MEMORY CLEARED").length;

  useEffect(() => {
    fetch("/api/memory").then((r) => r.json()).then(setEvents).catch(() => {});
  }, [memoryMsgs]);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 5000); // keep "x min ago" fresh
    return () => clearInterval(id);
  }, []);

  const zoneName = (id: string) => zones.find((z) => z.id === id)?.name ?? "Unmapped area";
  const latestByObject = new Map<string, StoredEvent>();
  for (const e of events) if (!latestByObject.has(e.object_id)) latestByObject.set(e.object_id, e);

  return (
    <section aria-labelledby="memory-title" className="flex min-h-0 flex-col gap-3">
      <h2 id="memory-title" className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Memory</h2>

      <div aria-label="What RecallLens remembers now" className="space-y-2">
        {latestByObject.size === 0 && (
          <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
            Nothing remembered yet. Put an everyday item (a charger, keys, glasses) in view of the camera.
          </p>
        )}
        {[...latestByObject.values()].map((e) => (
          <div key={e.object_id} className="rounded-xl border bg-card p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-lg font-semibold leading-tight">{e.label}</div>
                <div className="text-base">{e.type === "DISAPPEARED" ? "Last seen at " : ""}{zoneName(e.zone)}</div>
              </div>
              <StateBadge state={e.state} />
            </div>
            <div className="mt-2 text-sm text-muted-foreground">
              Last observed {time(e.timestamp)} ({ago(e.timestamp)}) · {Math.round(e.confidence * 100)}% · {e.object_id}
            </div>
          </div>
        ))}
      </div>

      <h3 className="mt-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Timeline</h3>
      <ScrollArea className="min-h-0 flex-1 rounded-xl border">
        <ol className="divide-y" aria-live="polite" aria-label="Memory timeline, newest first">
          {events.map((e, i) => {
            const current = latestByObject.get(e.object_id)?.id === e.id;
            return (
              <li key={e.id} className={`p-3 ${i === 0 ? "animate-in fade-in slide-in-from-top-1" : ""}`}>
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="font-mono text-muted-foreground">{time(e.timestamp)}</span>
                  <span className="flex gap-1">
                    {current ? <Badge variant="outline">current</Badge> : <Badge variant="ghost" className="text-muted-foreground">history</Badge>}
                    {e.source === "demo_event" && <Badge variant="secondary">simulated</Badge>}
                  </span>
                </div>
                <div className="mt-1 font-medium">{EVENT_TEXT[e.type]}: {e.label}</div>
                <div className="text-sm">
                  {e.previous_zone && e.type !== "STATE_CHANGED" ? `${zoneName(e.previous_zone)} → ` : ""}{zoneName(e.zone)} · <span className={e.state === "damaged" ? "font-semibold text-red-600" : ""}>{e.state}</span> · {Math.round(e.confidence * 100)}%
                </div>
                <div className={`mt-0.5 text-xs ${e.cognee_status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>{COGNEE_TEXT[e.cognee_status]} · {e.source.replace("_", " ")}</div>
              </li>
            );
          })}
        </ol>
      </ScrollArea>
    </section>
  );
}

export function StateBadge({ state }: { state: string }) {
  const cls = state === "damaged" ? "bg-red-600 text-white" : state === "missing" ? "bg-amber-500 text-black" : "bg-emerald-600 text-white";
  return <Badge className={`text-sm ${cls}`}>{state.toUpperCase()}</Badge>;
}
