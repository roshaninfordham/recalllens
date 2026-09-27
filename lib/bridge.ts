import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { Resolver } from "node:dns/promises";
import { join } from "node:path";
import { publish } from "./bus";
import { TOOLS, runTool } from "./tools";

// Public bridge. A tiny server on 127.0.0.1:3100, reachable only through a Cloudflare quick tunnel (valid HTTPS,
// works on any network). It serves exactly three things:
//   GET  /phone?t=…      the phone page (static HTML)               — phone pairing token
//   POST /frame?t=…      one JPEG frame, latest kept in memory only — phone pairing token
//   POST /tools/<name>   a Memory Concierge tool, for the hosted ClawMax agent — one-turn bearer token, revoked
//                        when that agent turn ends
// The Next.js app itself stays loopback-only and is never exposed.

const PORT = Number(process.env.RECALLLENS_BRIDGE_PORT ?? 3100);
const MAX_FRAME_BYTES = 800_000;
const IDLE_MS = 10 * 60_000;
const MAX_TOOL_BODY = 8_000;

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
  /** One-turn tokens for the hosted agent's tool calls → the RecallLens session they act for. */
  turnTokens?: Map<string, { sessionId: string; expiresAt: number }>;
}

const g = globalThis as unknown as { __rlBridge?: BridgeState };
const state = (g.__rlBridge ??= {});
const turnTokens = (state.turnTokens ??= new Map());

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function turnSession(auth: string | undefined): string | null {
  const supplied = auth?.replace(/^Bearer\s+/i, "") ?? "";
  for (const [token, t] of turnTokens) {
    if (t.expiresAt < Date.now()) turnTokens.delete(token);
    else if (supplied && safeEqual(supplied, token)) return t.sessionId;
  }
  return null;
}

const tokenOk = (supplied: string | null) => {
  const p = state.pairing;
  if (!p || !supplied) return false;
  return safeEqual(supplied, p.token);
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
  if (req.method === "POST" && url.pathname.startsWith("/tools/")) return handleTool(req, url.pathname.slice(7), send);
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

function handleTool(req: import("node:http").IncomingMessage, name: string, send: (code: number, body?: string, type?: string) => void) {
  const sessionId = turnSession(req.headers.authorization);
  if (!sessionId) return send(401, JSON.stringify({ error: "missing or expired turn token" }), "application/json");
  if (!TOOLS[name]) return send(404, JSON.stringify({ error: `unknown tool ${name}`, tools: Object.keys(TOOLS) }), "application/json");
  let body = "";
  req.on("data", (c: Buffer) => {
    body += c;
    if (body.length > MAX_TOOL_BODY) req.destroy();
  });
  req.on("end", async () => {
    armIdleTimer();
    let args: Record<string, unknown> = {};
    try {
      args = body ? JSON.parse(body) : {};
    } catch {
      return send(400, JSON.stringify({ error: "body must be JSON" }), "application/json");
    }
    try {
      send(200, JSON.stringify(await runTool(name, args, { sessionId, via: "clawmax-agent" })), "application/json");
    } catch (e) {
      send(502, JSON.stringify({ error: (e as Error).message }), "application/json");
    }
  });
}

function armIdleTimer() {
  clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    publish({ kind: "log", level: "warn", title: "BRIDGE CLOSED", detail: "No phone frames or agent tool calls for 10 minutes; tunnel closed" });
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
  await ensureBridge();
  if (!state.pairing || state.pairing.frames > 0) {
    state.pairing = { token: randomBytes(24).toString("base64url"), createdAt: Date.now(), frames: 0 };
  }
  armIdleTimer();
  return { url: `${state.publicUrl}/phone?t=${state.pairing.token}`, expiresInMs: IDLE_MS };
}

/** Starts the bridge if needed and returns its public URL (shared by phone pairing and the hosted agent). */
export async function ensureBridge(): Promise<string> {
  state.starting ??= ensureRunning().finally(() => (state.starting = undefined));
  await state.starting;
  armIdleTimer();
  return state.publicUrl!;
}

/** A bearer token valid for one agent turn (revoke it when the turn ends; it also expires on its own). */
export function issueTurnToken(sessionId: string, ttlMs = 180_000): string {
  const token = randomBytes(24).toString("base64url");
  turnTokens.set(token, { sessionId, expiresAt: Date.now() + ttlMs });
  return token;
}

export const revokeTurnToken = (token: string) => turnTokens.delete(token);

/** Ends phone pairing; the tunnel stays up only while the hosted agent still has live turn tokens. */
export function endPairing() {
  state.pairing = undefined;
  if (![...turnTokens.values()].some((t) => t.expiresAt > Date.now())) stopBridge();
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
