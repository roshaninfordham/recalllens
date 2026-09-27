// Object detection off the main thread: MediaPipe EfficientDet on the GPU (CPU fallback).
// For each sampled frame it (1) detects objects, (2) downsizes the frame, (3) draws numbered boxes ("marks") on it and
// encodes a JPEG, so the vision model can name each precise box. Nothing runs between samples, keeping load low.
// A classic worker (not a module worker): MediaPipe's wasm loader needs importScripts, which module workers lack.
// The model and wasm are served locally from /mediapipe (scripts/setup-models.sh).
importScripts("/mediapipe/vision_bundle.js");
const { FilesetResolver, ObjectDetector } = self.Vision;

// COCO classes that are never "things you pick up": people (privacy) and furniture/fixtures (noise).
const IGNORE = new Set(["person", "chair", "couch", "bed", "dining table", "toilet", "tv", "refrigerator", "oven", "sink", "potted plant", "bench", "microwave"]);
const COLORS = ["#16a34a", "#2563eb", "#db2777", "#ea580c", "#7c3aed", "#0891b2", "#ca8a04", "#dc2626"];

let detector;

async function init(model) {
  const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
  let lastError;
  for (const delegate of ["GPU", "CPU"]) {
    try {
      detector = await ObjectDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `/mediapipe/efficientdet_${model}.tflite`, delegate },
        runningMode: "IMAGE",
        scoreThreshold: 0.3,
        maxResults: 15,
      });
      return delegate;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

function detect(bitmap) {
  const w = bitmap.width, h = bitmap.height;
  return detector.detect(bitmap).detections
    .map((d) => ({
      label: d.categories[0]?.categoryName ?? "object",
      score: d.categories[0]?.score ?? 0,
      bbox: { x: d.boundingBox.originX / w, y: d.boundingBox.originY / h, width: d.boundingBox.width / w, height: d.boundingBox.height / h },
    }))
    .filter((d) => !IGNORE.has(d.label))
    .map((d, i) => ({ ...d, mark: i + 1 }));
}

async function markedJpeg(bitmap, proposals, maxDim, quality) {
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, w, h);
  const tag = Math.max(16, Math.round(h / 22));
  ctx.font = `bold ${Math.round(tag * 0.8)}px sans-serif`;
  ctx.lineWidth = Math.max(2, Math.round(h / 240));
  for (const p of proposals) {
    const c = COLORS[(p.mark - 1) % COLORS.length];
    const [x, y, bw, bh] = [p.bbox.x * w, p.bbox.y * h, p.bbox.width * w, p.bbox.height * h];
    ctx.strokeStyle = c;
    ctx.strokeRect(x, y, bw, bh);
    const text = String(p.mark);
    const tw = ctx.measureText(text).width + tag * 0.5;
    const ty = y >= tag ? y - tag : y;
    ctx.fillStyle = c;
    ctx.fillRect(x, ty, tw, tag);
    ctx.fillStyle = "#fff";
    ctx.fillText(text, x + tag * 0.25, ty + tag * 0.8);
  }
  return canvas.convertToBlob({ type: "image/jpeg", quality });
}

self.onmessage = async ({ data }) => {
  if (data.type === "init") {
    try {
      self.postMessage({ type: "ready", delegate: await init(data.model) });
    } catch (e) {
      self.postMessage({ type: "error", error: String(e?.message ?? e) });
    }
    return;
  }
  if (data.type === "detect") {
    const { bitmap, id, maxDim = 768, quality = 0.6 } = data;
    const t0 = performance.now();
    try {
      const proposals = detect(bitmap);
      const ms = performance.now() - t0;
      const jpeg = await markedJpeg(bitmap, proposals, maxDim, quality);
      self.postMessage({ type: "result", id, ms, proposals, jpeg });
    } catch (e) {
      self.postMessage({ type: "result", id, error: String(e?.message ?? e), proposals: [] });
    } finally {
      bitmap.close();
    }
  }
};
