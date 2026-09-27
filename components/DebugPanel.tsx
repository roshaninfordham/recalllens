"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { BusMessage } from "@/lib/bus";
import { api, time } from "@/lib/client";

const LEVEL: Record<string, string> = { ok: "text-emerald-700", warn: "text-amber-700", error: "text-red-700", info: "text-foreground" };

export function DebugPanel({ messages, phone, onPhone }: { messages: BusMessage[]; phone: string; onPhone: (p: string) => void }) {
  const [note, setNote] = useState<string | null>(null);

  const run = (label: string, fn: () => Promise<unknown>) => () =>
    fn().then(() => setNote(`${label}: done`)).catch((e: Error) => setNote(`${label}: ${e.message}`));

  return (
    <details className="group rounded-xl border bg-background">
      <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-semibold text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Developer panel · live event log, demo failsafe, settings
      </summary>
      <div className="grid gap-4 border-t p-4 lg:grid-cols-[1fr_320px]">
        <ol aria-label="Event log" className="max-h-72 overflow-auto rounded-lg bg-muted/50 p-2 font-mono text-xs leading-relaxed">
          {[...messages].reverse().map((m, i) => (
            <li key={i} className={LEVEL[m.level ?? "info"]}>
              <span className="text-muted-foreground">{time(m.at)}</span> <strong>{m.title}</strong> {m.detail}
            </li>
          ))}
        </ol>
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Demo failsafe (labelled “simulated”)</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={run("Charger first seen", () => api("/api/demo", { method: "POST", body: JSON.stringify({ kind: "first_seen" }) }))}>Simulate: Charger First Seen</Button>
              <Button size="sm" variant="outline" onClick={run("Charger damaged", () => api("/api/demo", { method: "POST", body: JSON.stringify({ kind: "damaged" }) }))}>Simulate: Charger Damaged</Button>
              <Button size="sm" variant="outline" onClick={run("Ask", () => api("/api/agent", { method: "POST", body: JSON.stringify({ message: "Where is my charger?", lang: "en-US" }) }))}>Simulate: User Asked Where</Button>
            </div>
          </div>
          <form key={phone} className="space-y-2" onSubmit={(e) => { e.preventDefault(); onPhone(String(new FormData(e.currentTarget).get("phone") ?? "")); }}>
            <Label htmlFor="phone">My phone (non-sensitive demo setting)</Label>
            <div className="flex gap-2">
              <Input id="phone" name="phone" defaultValue={phone} maxLength={60} />
              <Button type="submit" variant="secondary">Save</Button>
            </div>
          </form>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="destructive" onClick={run("Forget all memory", () => api("/api/memory", { method: "DELETE" }))}>Forget all memory</Button>
            <Button size="sm" variant="ghost" onClick={run("Clear cart", () => api("/api/cart", { method: "DELETE" }))}>Clear cart</Button>
          </div>
          {note && <p role="status" className="text-sm text-muted-foreground">{note}</p>}
        </div>
      </div>
    </details>
  );
}
