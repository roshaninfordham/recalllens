// Detector + pipeline eval. Runs the app's own detector worker (public/detector-worker.js) in a real browser on the
// eval set; scores the detector alone and, with PIPELINE=1, the full pipeline (numbered boxes → vision model naming).
// Usage: npm run dev (other terminal), then  npm run eval:detector [lite0|lite2]   (HEADED=1 = real GPU timings)
import { chromium } from "playwright";
import { analyzeFrame } from "../lib/vision.ts";
import { dataUrl, images, scorer } from "./eval-set.mts";
import type { Proposal } from "../lib/types.ts";

const model = process.argv[2] ?? "lite2";
const browser = await chromium.launch({ headless: process.env.HEADED !== "1" });
const page = await browser.newPage();
// tsx (esbuild keepNames) wraps functions in __name(); functions passed to page.evaluate need it defined.
await page.addInitScript("window.__name = (f) => f");
await page.goto(process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000");
const setup = await page.evaluate(async (model) => {
  const w = new Worker("/detector-worker.js");
  (window as unknown as { __w: Worker }).__w = w;
  const init = await new Promise<{ type: string; delegate?: string; error?: string }>((res) => {
    w.onmessage = (e) => res(e.data);
    w.postMessage({ type: "init", model });
  });
  return init;
}, model);
if (setup.type !== "ready") throw new Error(`detector init failed: ${setup.error}`);
console.log(`efficientdet_${model} · delegate ${setup.delegate}`);

const detectorScore = scorer();
const pipelineScore = scorer();
for (const img of images) {
  const r = await page.evaluate(async (src) => {
    const im = new Image();
    im.src = src;
    await im.decode();
    const w = (window as unknown as { __w: Worker }).__w;
    const run = async () => {
      const bitmap = await createImageBitmap(im);
      return new Promise<{ ms: number; proposals: unknown[]; jpeg: Blob }>((res) => {
        w.onmessage = (e) => res(e.data);
        w.postMessage({ type: "detect", id: 1, bitmap }, [bitmap]);
      });
    };
    await run(); // warm-up so timing reflects steady state
    const out = await run();
    const jpeg = await new Promise<string>((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result as string);
      fr.readAsDataURL(out.jpeg);
    });
    return { ms: out.ms, proposals: out.proposals, jpeg };
  }, dataUrl(img.file));
  const proposals = r.proposals as Proposal[];
  detectorScore.add(img, proposals, r.ms);
  if (process.env.PIPELINE === "1") {
    const v = await analyzeFrame(r.jpeg, proposals);
    pipelineScore.add(img, v.detections, r.ms + v.latency_ms);
  }
}
console.log("\ndetector only\n" + detectorScore.summary());
if (process.env.PIPELINE === "1") console.log("\ndetector + vision naming\n" + pipelineScore.summary());
await browser.close();
