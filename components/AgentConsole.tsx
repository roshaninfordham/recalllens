"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { BusMessage } from "@/lib/bus";
import type { Product } from "@/lib/types";
import { api } from "@/lib/client";

const LANGS = [
  ["en-US", "English"], ["hi-IN", "हिन्दी / Hinglish"], ["es-ES", "Español"], ["fr-FR", "Français"],
  ["de-DE", "Deutsch"], ["zh-CN", "中文"], ["ja-JP", "日本語"],
] as const;

const TOOL_TEXT: Record<string, string> = {
  recall_object: "Recall object history from Cognee",
  recall_recent_events: "Recall recent memory events",
  current_view: "Check what the camera sees now",
  remember_observation: "Save to memory",
  forget_memory: "Forget a memory",
  get_user_profile: "Identify phone compatibility",
  search_products: "Search products",
  add_to_cart: "Add to cart",
};

type Recognition = {
  lang: string; interimResults: boolean; continuous: boolean;
  onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void;
  onend: () => void; onerror: (e: { error: string }) => void; start(): void; stop(): void;
};

export function AgentConsole({ messages }: { messages: BusMessage[] }) {
  const [text, setText] = useState("");
  const [lang, setLang] = useState("en-US");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [speak, setSpeak] = useState(true);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const recRef = useRef<Recognition | null>(null);
  const spoken = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);
  const agentMsgs = messages.filter((m) => m.kind === "agent");
  const voiceSupported = typeof window !== "undefined" && ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);

  useEffect(() => {
    // Braces matter: newer Chrome returns a Promise from scrollIntoView, and React treats a returned value as cleanup.
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [agentMsgs.length]);

  // Speak new agent replies and proactive notices (once each).
  useEffect(() => {
    const fresh = agentMsgs.slice(spoken.current);
    spoken.current = agentMsgs.length;
    if (!speak || typeof speechSynthesis === "undefined") return;
    for (const m of fresh) {
      if ((m.title === "AGENT" || m.title === "PROACTIVE") && m.detail && Date.now() - Date.parse(m.at) < 15_000) {
        const u = new SpeechSynthesisUtterance(m.detail);
        u.lang = lang;
        speechSynthesis.speak(u);
      }
    }
  }, [agentMsgs, speak, lang]);

  async function send(message: string) {
    if (!message.trim() || busy) return;
    setBusy(true);
    setText("");
    try {
      await api("/api/agent", { method: "POST", body: JSON.stringify({ message, lang }) });
    } catch {
      // Error is published to the stream by the server and rendered below.
    } finally {
      setBusy(false);
    }
  }

  function toggleMic() {
    if (listening) return recRef.current?.stop();
    const Ctor = (window as unknown as Record<string, new () => Recognition>).SpeechRecognition ??
      (window as unknown as Record<string, new () => Recognition>).webkitSpeechRecognition;
    const rec = new Ctor();
    rec.lang = lang;
    rec.interimResults = true;
    rec.continuous = false;
    let final = "";
    rec.onresult = (e) => {
      const r = Array.from(e.results);
      final = r.map((x) => x[0].transcript).join(" ");
      setText(final);
    };
    rec.onerror = (e) => setVoiceError(e.error === "not-allowed" ? "Microphone permission denied. Type instead." : `Voice error: ${e.error}`);
    rec.onend = () => {
      setListening(false);
      if (final.trim()) send(final);
    };
    setVoiceError(null);
    recRef.current = rec;
    rec.start();
    setListening(true);
  }

  return (
    <section aria-labelledby="agent-title" className="flex min-h-0 flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 id="agent-title" className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Memory Concierge</h2>
        <div className="flex items-center gap-3">
          <Select value={lang} onValueChange={(v) => setLang(v ?? "en-US")}>
            <SelectTrigger size="sm" className="w-36" aria-label="Speech language"><SelectValue>{(v: string) => LANGS.find(([code]) => code === v)?.[1] ?? v}</SelectValue></SelectTrigger>
            <SelectContent>{LANGS.map(([v, n]) => <SelectItem key={v} value={v}>{n}</SelectItem>)}</SelectContent>
          </Select>
          <Switch id="speak" checked={speak} onCheckedChange={setSpeak} />
          <Label htmlFor="speak" className="text-sm">Speak</Label>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1 rounded-xl border">
        <div className="space-y-2 p-3" aria-live="polite" aria-label="Agent activity">
          {agentMsgs.length === 0 && (
            <p className="p-2 text-sm text-muted-foreground">Ask “Where is my charger?” by voice or text.</p>
          )}
          {agentMsgs.map((m, i) => <AgentLine key={i} m={m} />)}
          {busy && <p className="px-2 text-sm text-muted-foreground animate-pulse">Memory Concierge is thinking…</p>}
          <div ref={endRef} />
        </div>
      </ScrollArea>

      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); send(text); }}>
        <Input className="h-12 min-w-0 flex-1 text-base" value={text} onChange={(e) => setText(e.target.value)} placeholder={listening ? "Listening…" : "Ask or instruct…"} aria-label="Message to the agent" maxLength={1000} />
        {voiceSupported && (
          <Button type="button" size="lg" className={`h-12 ${listening ? "bg-red-600 hover:bg-red-600/90" : ""}`} variant={listening ? "default" : "outline"} onClick={toggleMic} aria-pressed={listening} aria-label={listening ? "Stop listening" : "Speak"}>
            {listening ? "■ Stop" : "🎤 Speak"}
          </Button>
        )}
        <Button type="submit" size="lg" className="h-12" disabled={busy || !text.trim()}>Send</Button>
      </form>
      {!voiceSupported && <p className="text-sm text-muted-foreground">Voice input isn’t supported in this browser. Use Chrome or Safari, or type.</p>}
      {voiceError && <p role="alert" className="text-sm text-destructive">{voiceError}</p>}

      <CartPanel messages={messages} />
    </section>
  );
}

function AgentLine({ m }: { m: BusMessage }) {
  if (m.title === "USER")
    return <div className="ml-8 rounded-xl bg-primary px-3 py-2 text-base text-primary-foreground">{m.detail}</div>;
  if (m.title === "AGENT")
    return <div className="mr-8 rounded-xl bg-muted px-3 py-2 text-base">{m.detail}</div>;
  if (m.title === "PROACTIVE")
    return <div role="status" className="rounded-xl border border-amber-400 bg-amber-50 px-3 py-2 text-base text-amber-950">⚠ {m.detail}</div>;
  const data = m.data as { tool?: string; via?: string } | undefined;
  if (m.title === "TOOL CALL")
    return <div className="flex items-center gap-2 px-1 text-sm text-muted-foreground"><span aria-hidden>⟳</span>{TOOL_TEXT[data?.tool ?? ""] ?? data?.tool}<code className="truncate text-xs">{m.detail}</code></div>;
  if (m.title === "TOOL RESULT")
    return <div className="flex items-center gap-2 px-1 text-sm font-medium text-emerald-700"><span aria-hidden>✓</span>{TOOL_TEXT[data?.tool ?? ""] ?? data?.tool}<span className="text-xs font-normal text-muted-foreground">{m.detail?.split(" ").pop()}</span></div>;
  return <div role="alert" className="px-1 text-sm text-destructive">✕ {m.title}: {m.detail}</div>;
}

function CartPanel({ messages }: { messages: BusMessage[] }) {
  const [items, setItems] = useState<{ product: Product; added_by: string; added_at: string }[]>([]);
  const cartEvents = messages.filter((m) => m.kind === "cart").length;
  useEffect(() => {
    fetch("/api/cart").then((r) => r.json()).then(setItems).catch(() => {});
  }, [cartEvents]);
  if (!items.length) return null;
  return (
    <div aria-label="Cart" className="rounded-xl border-2 border-emerald-600 bg-emerald-50 p-3 text-emerald-950">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider">Cart · not purchased</span>
        <Badge className="bg-emerald-600 text-white">{items.length}</Badge>
      </div>
      {items.map((it, i) => (
        <div key={i} className="mt-2 flex items-baseline justify-between gap-3">
          <div>
            <div className="text-base font-semibold">{it.product?.name}</div>
            <div className="text-sm">{it.product?.connector} · added by {it.added_by}</div>
          </div>
          <div className="font-mono text-base">${it.product?.price.toFixed(2)}</div>
        </div>
      ))}
    </div>
  );
}
