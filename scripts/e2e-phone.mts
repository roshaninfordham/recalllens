// End-to-end phone pairing through the real public tunnel: a dashboard browser shows the QR link; a second browser
// emulating a phone (fake camera = .e2e/normal.mjpeg) opens that https://*.trycloudflare.com URL, taps Start, and the
// dashboard must receive frames and detect objects from them. Saves screenshots of the QR panel and the phone page.
// Usage: npm run dev (other terminal), then npm run e2e:phone   (needs cloudflared)
import { chromium, devices } from "playwright";
import { resolve } from "node:path";
import { resolveTunnelHost } from "../lib/bridge.ts";

const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
const SHOTS = resolve("docs/screenshots");
const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s] ${m}`);

const laptop = await chromium.launch({ headless: process.env.HEADED !== "1", args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
let phone: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const ctx = await laptop.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.5, permissions: ["camera"] });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => log(`PAGE ERROR: ${e.message}`));
  await page.goto(BASE);
  await page.getByRole("button", { name: "Accept and Start" }).waitFor(); // consent form rendered
  for (const cb of await page.getByRole("checkbox").all()) await cb.check();
  await page.getByRole("button", { name: "Accept and Start" }).click();
  await page.getByRole("heading", { name: "RecallLens" }).waitFor();
  await page.evaluate(async () => {
    const h = { "x-consent-id": localStorage.getItem("recalllens.consent_id") ?? "" };
    await fetch("/api/memory", { method: "DELETE", headers: h });
    await fetch("/api/cart", { method: "DELETE", headers: h });
  });

  // 1. Pick the phone camera → QR panel with a real tunnel URL.
  await page.getByLabel("Camera source").click();
  const [pair] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/phone/pair") && r.request().method() === "POST", { timeout: 45_000 }),
    page.getByRole("option", { name: /Phone camera/ }).click(),
  ]);
  const { url, error } = await pair.json();
  if (!url) throw new Error(`pairing failed: ${error}`);
  if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/phone\?t=/.test(url)) throw new Error(`unexpected pairing URL ${url}`);
  await page.getByAltText(/QR code/).waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/08-phone-qr.png` });
  log(`📸 08-phone-qr.png · tunnel ${new URL(url).host}`);

  // 2. Phone opens the link over the internet and starts streaming. A real phone resolves the tunnel with its own
  //    DNS; this Mac's resolver may have cached "not found", so point the phone browser at the public answer.
  const host = new URL(url).hostname;
  const [ip] = await resolveTunnelHost(host);
  if (!ip) throw new Error(`tunnel host ${host} does not resolve`);
  phone = await chromium.launch({
    headless: process.env.HEADED !== "1",
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${resolve(".e2e/normal.mjpeg")}`, `--host-resolver-rules=MAP ${host} ${ip}`],
  });
  const pctx = await phone.newContext({ ...devices["iPhone 13"], permissions: ["camera"] });
  const ppage = await pctx.newPage();
  ppage.on("pageerror", (e) => log(`PHONE PAGE ERROR: ${e.message}`));
  // Quick tunnels can take a few seconds to route; retry the first load.
  for (let i = 0; ; i++) {
    const res = await ppage.goto(url).catch(() => null);
    if (res?.ok()) break;
    if (i > 10) throw new Error(`phone could not open the tunnel URL (status ${res?.status()})`);
    await ppage.waitForTimeout(2000);
  }
  // The token is the only key: a wrong one must be refused.
  const bad = await ppage.request.get(url.replace(/t=.*/, "t=wrong"));
  if (bad.status() !== 403) throw new Error(`bad token should be 403, got ${bad.status()}`);
  await ppage.getByRole("button", { name: "Start" }).click();
  await ppage.getByText("Live to your laptop").waitFor({ timeout: 30_000 });
  await ppage.waitForTimeout(1500);
  await ppage.screenshot({ path: `${SHOTS}/09-phone-page.png` });
  log("📸 09-phone-page.png · phone streaming");

  // 3. Laptop shows the phone feed and detects from it.
  await page.getByText("Phone camera connected").waitFor({ timeout: 30_000 });
  await page.getByText("LIVE", { exact: true }).first().waitFor();
  const res = await page.waitForResponse((r) => r.url().endsWith("/api/vision") && r.request().method() === "POST", { timeout: 60_000 });
  const body = await res.json();
  if (!res.ok()) throw new Error(`vision failed on phone frames: ${body.error}`);
  log(`vision on phone frame: ${body.tracked.map((d: { label: string }) => d.label).join(", ") || "(nothing personal)"} · ${body.latency_ms}ms`);
  await page.getByText(/Last observed/).first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/10-phone-live.png` });
  log("📸 10-phone-live.png");

  // 4. Disconnect closes the tunnel.
  await page.getByRole("button", { name: "Disconnect" }).click();
  await page.waitForTimeout(1500);
  const status = await (await page.request.get(`${BASE}/api/phone/pair`)).json();
  if (status.active || status.tunnel) throw new Error(`bridge still open after disconnect: ${JSON.stringify(status)}`);
  log("✅ phone pairing end-to-end passed (tunnel closed)");
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await laptop.close();
  await phone?.close();
}
