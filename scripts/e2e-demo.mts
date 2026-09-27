// End-to-end demo run through the real UI, real camera pipeline, real Cognee and the real agent.
// Chromium plays .e2e/*.mjpeg as its webcam (see make-test-camera.sh), so getUserMedia → sampler → vision →
// aggregator → Cognee → agent → cart all run for real. Two camera sessions share one consent and one server:
// first the intact charger (detect, remember, recall), then the broken one (damage, replacement), just like swapping
// the object in front of a real camera. Saves a screenshot of every screen to docs/screenshots/.
//
// Usage: npm run dev (other terminal), then: npm run e2e
import { chromium, type Browser, type BrowserContextOptions, type Page } from "playwright";
import { resolve } from "node:path";
import { DEFAULT_ZONES } from "../lib/zones.ts";

const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
const SHOTS = resolve("docs/screenshots");
const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s] ${m}`);
const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(1200); // let smooth-scroll and entry animations settle
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
  log(`📸 ${name}.png`);
};

async function ask(page: Page, text: string) {
  const input = page.getByLabel("Message to the agent");
  await input.fill(text);
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/agent") && r.request().method() === "POST", { timeout: 90_000 }),
    input.press("Enter"),
  ]);
  const body = await res.json();
  if (!res.ok()) throw new Error(`agent failed: ${body.error}`);
  log(`agent (${body.mode}, ${body.ms}ms): ${body.reply}`);
  await page.getByText(body.reply.slice(0, 40), { exact: false }).first().waitFor();
  return body.reply as string;
}

const browsers: Browser[] = [];
async function openCamera(scene: "normal" | "damaged", storageState?: BrowserContextOptions["storageState"]) {
  const browser = await chromium.launch({
    headless: process.env.HEADED !== "1",
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${resolve(`.e2e/${scene}.mjpeg`)}`],
  });
  browsers.push(browser);
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.5, permissions: ["camera", "microphone"], storageState });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => log(`PAGE ERROR: ${e.message}`));
  return p;
}
let page = await openCamera("normal");

try {
  // 1. Consent gate blocks everything until all three acknowledgements are checked.
  await page.goto(BASE);
  const accept = page.getByRole("button", { name: "Accept and Start" });
  await accept.waitFor();
  if (!(await accept.isDisabled())) throw new Error("Accept must be disabled before consent");
  await shot(page, "01-consent");
  for (const cb of await page.getByRole("checkbox").all()) await cb.click();
  await accept.click();
  await page.getByRole("heading", { name: "RecallLens" }).waitFor();
  log("consent accepted");

  // Start from a clean memory and cart.
  await page.evaluate(async (DEFAULT_ZONES) => {
    const h = { "x-consent-id": localStorage.getItem("recalllens.consent_id") ?? "" };
    await fetch("/api/memory", { method: "DELETE", headers: h });
    await fetch("/api/cart", { method: "DELETE", headers: h });
    await fetch("/api/settings", { method: "PUT", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ zones: DEFAULT_ZONES }) });
  }, DEFAULT_ZONES);
  log("memory, cart and zones reset");

  // 2. Live camera → vision → FIRST_SEEN written to Cognee.
  await page.getByText("LIVE", { exact: true }).first().waitFor({ timeout: 20_000 });
  await page.getByText("First seen:").first().waitFor({ timeout: 60_000 });
  await page.getByText("In Cognee").first().waitFor({ timeout: 30_000 });
  log("charger detected and stored in Cognee");
  await shot(page, "02-live-detection-memory");

  // 3. Wait for Cognee to index, then ask where it is.
  log("waiting 35s for Cognee indexing…");
  await page.waitForTimeout(35_000);
  const where = await ask(page, "Where is my charger?");
  if (!/table|hall/i.test(where)) throw new Error(`recall answer lacks the location: ${where}`);
  await shot(page, "03-recall-answer");

  // 4. Swap in the broken cable (second camera session, same consent) → STATE_CHANGED + one proactive notice.
  const state = await page.context().storageState();
  await page.context().browser()!.close();
  page = await openCamera("damaged", state);
  await page.goto(BASE);
  await page.getByText("LIVE", { exact: true }).first().waitFor({ timeout: 20_000 });
  log("waiting for the damaged charger to appear…");
  await page.getByText("appears damaged").first().waitFor({ timeout: 180_000 });
  await page.getByText("State changed:").first().waitFor();
  log("damage detected");
  await shot(page, "04-damage-detected");

  // 5. Hinglish request → profile → search → add to cart (never purchase).
  await page.getByLabel("Speech language").click();
  await page.getByRole("option", { name: "हिन्दी / Hinglish" }).click();
  await ask(page, "Mera charger toot gaya hai, mere phone ke liye naya charger dhoondo.");
  await page.getByLabel("Cart").waitFor({ timeout: 15_000 });
  const cart = await page.getByLabel("Cart").innerText();
  if (!/not purchased/i.test(cart)) throw new Error("cart must say not purchased");
  log(`cart: ${cart.replace(/\s+/g, " ")}`);
  await shot(page, "05-replacement-in-cart");

  // 6. Developer panel: live event log proves each hop happened.
  await page.getByText("Developer panel").click();
  await page.getByLabel("Event log").waitFor();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOTS}/06-developer-panel.png`, fullPage: true });
  log("📸 06-developer-panel.png");
  await page.getByText("Developer panel").click();

  // 7. Zone calibration mode.
  await page.getByRole("button", { name: "Edit zones" }).click();
  await shot(page, "07-zone-editor");
  await page.getByRole("button", { name: "Done editing zones" }).click();

  const health = await (await page.request.get(`${BASE}/api/health`)).json();
  log(`health: ${JSON.stringify(health)}`);
  log("✅ end-to-end run passed");
} catch (e) {
  await shot(page, "zz-failure").catch(() => {});
  console.error(e);
  process.exitCode = 1;
} finally {
  for (const b of browsers) await b.close().catch(() => {});
}
