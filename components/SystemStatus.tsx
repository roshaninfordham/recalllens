"use client";
import { useEffect, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { CameraStatus } from "./LiveCamera";

interface Health {
  cognee: boolean; clawmax: boolean; agent: boolean; vision: boolean; commerce: boolean;
  detail: { cognee: string; clawmax: string; agent_mode: string; vision: string };
}

type Tone = "ok" | "warn" | "bad" | "idle";
const DOT: Record<Tone, string> = { ok: "bg-emerald-500", warn: "bg-amber-500", bad: "bg-red-500", idle: "bg-neutral-400" };

function Pill({ name, value, tone, detail }: { name: string; value: string; tone: Tone; detail?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<div tabIndex={0} className="flex items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring" />}>
        <span aria-hidden className={`size-2.5 rounded-full ${DOT[tone]}`} />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{name}</span>
        <span className="text-sm font-medium">{value}</span>
      </TooltipTrigger>
      {detail && <TooltipContent>{detail}</TooltipContent>}
    </Tooltip>
  );
}

export function SystemStatus({ camera, streamConnected }: { camera: CameraStatus; streamConnected: boolean }) {
  const [h, setH] = useState<Health | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    const load = () => fetch("/api/health").then((r) => r.json()).then((j) => { setH(j); setErr(false); }).catch(() => setErr(true));
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, []);

  const voice = typeof window !== "undefined" && ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);
  const cam: Tone = camera.state === "live" ? "ok" : camera.state === "starting" ? "warn" : "bad";
  return (
    <div role="status" aria-label="System status" className="flex flex-wrap gap-2">
      <Pill name="Camera" value={camera.state === "live" ? "LIVE" : camera.state} tone={cam} detail={camera.label} />
      <Pill name="Vision" value={camera.visionError ? "error" : camera.visionLatency ? `${camera.analysisFps} FPS` : h?.vision ? "ready" : "off"}
        tone={camera.visionError ? "bad" : h?.vision ? "ok" : "bad"} detail={camera.visionError ?? h?.detail.vision} />
      <Pill name="Cognee" value={err ? "unreachable" : h ? (h.cognee ? "connected" : "error") : "…"} tone={h?.cognee ? "ok" : h ? "bad" : "idle"} detail={h?.detail.cognee} />
      <Pill name="ClawMax" value={h ? (h.clawmax ? "connected" : "not connected") : "…"} tone={h?.clawmax ? "ok" : h ? "warn" : "idle"} detail={h?.detail.clawmax} />
      <Pill name="Agent" value={h ? (h.agent ? (h.detail.agent_mode === "clawmax" ? "ClawMax" : "local runtime") : "unavailable") : "…"} tone={h?.agent ? "ok" : h ? "bad" : "idle"} detail={h?.detail.clawmax} />
      <Pill name="Voice" value={voice ? "ready" : "type only"} tone={voice ? "ok" : "warn"} />
      <Pill name="Live" value={streamConnected ? "streaming" : "reconnecting"} tone={streamConnected ? "ok" : "warn"} />
    </div>
  );
}
