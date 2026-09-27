import { EventEmitter } from "node:events";

/** Everything the UI's live panels render: debug log lines, memory updates, agent steps, cart changes. */
export interface BusMessage {
  kind: "log" | "memory" | "agent" | "cart" | "vision" | "status";
  at: string;
  title: string;
  detail?: string;
  data?: unknown;
  level?: "info" | "ok" | "warn" | "error";
}

const g = globalThis as unknown as { __rlBus?: EventEmitter; __rlRecent?: BusMessage[] };
const bus = (g.__rlBus ??= new EventEmitter().setMaxListeners(50));
const recent = (g.__rlRecent ??= []);

export function publish(m: Omit<BusMessage, "at">) {
  const msg = { ...m, at: new Date().toISOString() };
  recent.push(msg);
  if (recent.length > 200) recent.shift();
  bus.emit("msg", msg);
}

export function subscribe(fn: (m: BusMessage) => void): () => void {
  bus.on("msg", fn);
  return () => bus.off("msg", fn);
}

export const recentMessages = () => [...recent];

/** Drop the replay buffer (after "forget all memory" the old conversation must not come back on reload). */
export function clearRecent() {
  recent.length = 0;
}
