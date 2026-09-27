// Vision eval (cloud VLM): recall, box tightness (IoU) and naming accuracy on everyday objects.
// Usage: npm run eval:vision
import { analyzeFrame } from "../lib/vision.ts";
import { dataUrl, images, scorer } from "./eval-set.mts";

const score = scorer();
for (const img of images) {
  const r = await analyzeFrame(dataUrl(img.file));
  score.add(img, r.detections, r.latency_ms);
}
console.log("\n" + score.summary());
