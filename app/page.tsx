"use client";
import { useCallback, useEffect, useState } from "react";
import { ConsentGate } from "@/components/ConsentGate";
import { LiveCamera, type CameraStatus } from "@/components/LiveCamera";
import { MemoryPanel } from "@/components/MemoryPanel";
import { AgentConsole } from "@/components/AgentConsole";
import { SystemStatus } from "@/components/SystemStatus";
import { DebugPanel } from "@/components/DebugPanel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useStream } from "@/hooks/use-stream";
import { CONSENT_KEY, api, consentId } from "@/lib/client";
import type { Zone } from "@/lib/types";

export default function Home() {
  const [consent, setConsent] = useState<"checking" | "none" | "ok">("checking");

  // A stored id only counts if the server still holds the receipt.
  useEffect(() => {
    fetch(`/api/consent?id=${encodeURIComponent(consentId() ?? "")}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.receipt?.policy_version === j.policy_version) setConsent("ok");
        else {
          localStorage.removeItem(CONSENT_KEY);
          setConsent("none");
        }
      })
      .catch(() => setConsent("none"));
  }, []);

  if (consent === "checking") return <main className="grid min-h-dvh place-items-center text-muted-foreground">Loading…</main>;
  if (consent === "none") return <ConsentGate onAccepted={() => setConsent("ok")} />;
  return <App />;
}

function App() {
  const { messages, connected } = useStream();
  const [zones, setZones] = useState<Zone[]>([]);
  const [phone, setPhone] = useState("");
  const [camera, setCamera] = useState<CameraStatus>({ state: "off", analysisFps: 0 });

  useEffect(() => {
    fetch("/api/settings").then((r) => r.json()).then((s) => { setZones(s.zones); setPhone(s.phone_model); });
  }, []);

  const saveSettings = useCallback(async (patch: { zones?: Zone[]; phone_model?: string }) => {
    const s = await api<{ zones: Zone[]; phone_model: string }>("/api/settings", { method: "PUT", body: JSON.stringify(patch) });
    setZones(s.zones);
    setPhone(s.phone_model);
  }, []);
  const onZones = useCallback((z: Zone[]) => { setZones(z); saveSettings({ zones: z }); }, [saveSettings]);

  return (
    <TooltipProvider>
      <div className="flex min-h-dvh flex-col gap-4 bg-muted/40 p-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">RecallLens</h1>
            <p className="text-base text-muted-foreground">Your world, remembered. <span className="font-medium text-foreground">See · Remember · Act</span></p>
          </div>
          <SystemStatus camera={camera} streamConnected={connected} />
        </header>

        <main className="grid gap-4 lg:h-[calc(100dvh-9.5rem)] lg:min-h-[36rem] lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.1fr)]">
          <div className="min-h-0 rounded-2xl border bg-background p-4">
            <LiveCamera zones={zones} onZonesChange={onZones} onStatus={setCamera} />
          </div>
          <div className="flex min-h-[28rem] flex-col rounded-2xl border bg-background p-4 lg:min-h-0">
            <MemoryPanel messages={messages} zones={zones} />
          </div>
          <div className="flex min-h-[28rem] flex-col rounded-2xl border bg-background p-4 lg:min-h-0">
            <AgentConsole messages={messages} />
          </div>
        </main>

        <DebugPanel messages={messages} phone={phone} onPhone={(p) => saveSettings({ phone_model: p })} />
      </div>
    </TooltipProvider>
  );
}
