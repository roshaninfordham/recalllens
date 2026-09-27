import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { Resolver } from "node:dns/promises";
import { join } from "node:path";
import { publish } from "./bus";

// Phone camera bridge. A tiny server on 127.0.0.1:3100, reachable from the phone only through a Cloudflare quick
// tunnel (valid HTTPS, works on any network). It serves exactly two things, both gated by a one-time pairing token:
//   GET  /phone?t=…   the phone page (static HTML, no framework, no Next.js assets)
//   POST /frame?t=…   one JPEG frame; only the latest frame is kept, in memory
// The Next.js app itself stays loopback-only and is never exposed.

const PORT = Number(process.env.RECALLLENS_BRIDGE_PORT ?? 3100);
const MAX_FRAME_BYTES = 800_000;
const IDLE_MS = 10 * 60_000;

interface Pairing {
  token: string;
  createdAt: number;
  lastFrameAt?: number;
  frames: number;
  frame?: Buffer;
}

interface BridgeState {
  server?: Server;
  tunnel?: ChildProcess;
  publicUrl?: string;
  pairing?: Pairing;
  idleTimer?: NodeJS.Timeout;
  starting?: Promise<void>;
}

const g = globalThis as unknown as { __rlBridge?: BridgeState };
const state = (g.__rlBridge ??= {});

const tokenOk = (supplied: string | null) => {
  const p = state.pairing;
  if (!p || !supplied) return false;
  const a = Buffer.from(supplied), b = Buffer.from(p.token);
  return a.length === b.length && timingSafeEqual(a, b);
};

function phonePage(): string {
  return readFileSync(join(process.cwd(), "lib/phone-page.html"), "utf8");
}

function handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
  const url = new URL(req.url ?? "/", "http://bridge");
  const send = (code: number, body = "", type = "text/plain") => {
    res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    res.end(body);
  };
  if (!tokenOk(url.searchParams.get("t"))) return send(403, "This pairing link is invalid or has expired. Scan a new QR code on your laptop.");

  if (req.method === "GET" && url.pathname === "/phone") return send(200, phonePage(), "text/html; charset=utf-8");

  if (req.method === "POST" && url.pathname === "/frame") {
    if (req.headers["content-type"] !== "image/jpeg") return send(415);
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_FRAME_BYTES) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => {
      const p = state.pairing;
      if (!p || size > MAX_FRAME_BYTES) return send(413);
      const first = p.frames === 0;
      p.frame = Buffer.concat(chunks);
      p.frames++;
      p.lastFrameAt = Date.now();
      armIdleTimer();
      if (first) publish({ kind: "log", level: "ok", title: "PHONE CONNECTED", detail: "Receiving the phone camera" });
      send(204);
    });
    return;
  }
  send(404);
}

function armIdleTimer() {
  clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    publish({ kind: "log", level: "warn", title: "PHONE DISCONNECTED", detail: "No frames for 10 minutes; tunnel closed" });
    stopBridge();
  }, IDLE_MS);
}

function startTunnel(): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
    state.tunnel = proc;
    const timer = setTimeout(() => reject(new Error("Cloudflare tunnel did not start within 30s")), 30_000);
    const onData = (d: Buffer) => {
      const m = d.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(e.code === "ENOENT" ? "cloudflared is not installed (brew install cloudflared)" : e.message));
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`cloudflared exited (${code}) before the tunnel was ready`)); // no-op if already resolved
      if (state.tunnel === proc) {
        state.tunnel = undefined;
        state.publicUrl = undefined;
      }
    });
  });
}

async function ensureRunning() {
  if (!state.server) {
    const server = createServer(handle);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(PORT, "127.0.0.1", resolve);
    });
    state.server = server;
  }
  if (!state.publicUrl) {
    const url = await startTunnel();
    await waitUntilReachable(url);
    state.publicUrl = url;
  }
}

/**
 * Resolves a quick-tunnel hostname at trycloudflare.com's authoritative nameservers. Recursive resolvers (this Mac,
 * the Wi-Fi router, even 1.1.1.1) cache "not found" if asked before the name exists (~15 s after start), which
 * would then break the phone's first scan; authoritative servers never cache.
 */
export async function resolveTunnelHost(host: string): Promise<string[]> {
  const system = new Resolver();
  const ns = await system.resolveNs("trycloudflare.com");
  const ips = (await Promise.all(ns.map((n) => system.resolve4(n).catch(() => [] as string[])))).flat();
  const authoritative = new Resolver();
  authoritative.setServers(ips);
  return authoritative.resolve4(host).catch(() => [] as string[]);
}

/** Show the QR only once a phone could actually open the link. */
async function waitUntilReachable(url: string) {
  const host = new URL(url).hostname;
  for (let i = 0; i < 45; i++) {
    if ((await resolveTunnelHost(host)).length) {
      await new Promise((r) => setTimeout(r, 2000)); // let the edge pick up the route
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Cloudflare tunnel started but its address never appeared in DNS; try again");
}

/**
 * Returns the pairing URL, starting the bridge if needed. Concurrent calls share one startup, and a link no phone
 * has used yet is returned again rather than replaced (so a double-mounted UI doesn't invalidate its own QR code).
 */
export async function startPairing(): Promise<{ url: string; expiresInMs: number }> {
  state.starting ??= ensureRunning().finally(() => (state.starting = undefined));
  await state.starting;
  if (!state.pairing || state.pairing.frames > 0) {
    state.pairing = { token: randomBytes(24).toString("base64url"), createdAt: Date.now(), frames: 0 };
  }
  armIdleTimer();
  return { url: `${state.publicUrl}/phone?t=${state.pairing.token}`, expiresInMs: IDLE_MS };
}

export function stopBridge() {
  clearTimeout(state.idleTimer);
  state.pairing = undefined;
  state.tunnel?.kill();
  state.tunnel = undefined;
  state.publicUrl = undefined;
  state.server?.close();
  state.server = undefined;
}

export function latestFrame(): { frame: Buffer; at: number } | null {
  const p = state.pairing;
  return p?.frame && p.lastFrameAt ? { frame: p.frame, at: p.lastFrameAt } : null;
}

export function bridgeStatus() {
  const p = state.pairing;
  return { active: Boolean(p), tunnel: Boolean(state.publicUrl), frames: p?.frames ?? 0, lastFrameAt: p?.lastFrameAt ?? null };
}
