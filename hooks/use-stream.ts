"use client";
import { useEffect, useState } from "react";
import type { BusMessage } from "@/lib/bus";

/** Subscribes to /api/stream (SSE). EventSource reconnects on its own after server restarts. */
export function useStream(): { messages: BusMessage[]; connected: boolean } {
  const [messages, setMessages] = useState<BusMessage[]>([]);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.onopen = () => {
      setConnected(true);
      setMessages([]); // server replays its recent buffer on every (re)connect
    };
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      const msg = JSON.parse(e.data) as BusMessage;
      // A memory reset starts a clean session view in every open tab.
      setMessages((m) => (msg.title === "MEMORY CLEARED" ? [msg] : [...m.slice(-299), msg]));
    };
    return () => es.close();
  }, []);
  return { messages, connected };
}
