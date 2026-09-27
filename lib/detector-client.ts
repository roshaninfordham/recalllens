"use client";
import type { Proposal } from "./types";

export interface DetectResult {
  proposals: Proposal[];
  jpeg: Blob;
  ms: number;
}

/**
 * Talks to public/detector-worker.js. One request at a time (the sampler never overlaps frames).
 * `ready` rejects if the detector can't start (e.g. no wasm/model served); callers fall back to vision-only.
 */
export function createDetector(model = "lite2") {
  const worker = new Worker("/detector-worker.js");
  let pending: ((r: DetectResult & { error?: string }) => void) | null = null;
  const ready = new Promise<string>((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.type === "ready") resolve(data.delegate);
      else if (data.type === "error") reject(new Error(data.error));
      else if (data.type === "result" && pending) {
        pending(data);
        pending = null;
      }
    };
    worker.onerror = (e) => reject(new Error(e.message || "detector worker failed to load"));
  });
  worker.postMessage({ type: "init", model });

  return {
    ready,
    async detect(bitmap: ImageBitmap, maxDim: number, quality: number): Promise<DetectResult> {
      await ready;
      const r = await new Promise<DetectResult & { error?: string }>((resolve) => {
        pending = resolve;
        worker.postMessage({ type: "detect", id: Date.now(), bitmap, maxDim, quality }, [bitmap]);
      });
      if (r.error) throw new Error(r.error);
      return r;
    },
    close: () => worker.terminate(),
  };
}

export const blobToDataUrl = (b: Blob) =>
  new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(b);
  });
