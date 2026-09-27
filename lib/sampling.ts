// Frame sampling policy: the <video> renders at native FPS; only a few frames/second go to vision.

export const SAMPLING = {
  tickMs: 250, // how often we look at the video (cheap 32x18 thumbnail diff)
  thumbW: 32,
  thumbH: 18,
  nearIdentical: 3, // mean |Δgray| below this = same frame, never sent
  active: 6, // moderate change → up to 2 FPS
  major: 18, // big change → analyze immediately
  activeIntervalMs: 500,
  idleIntervalMs: 2000, // 0.5 FPS while scene is steady but not identical
  heartbeatMs: 10_000, // even identical frames get re-checked this often (lighting drift, disappearance timers)
  maxDim: 768,
  jpegQuality: 0.6,
};

/** Mean absolute difference between two RGBA buffers, in grayscale units 0..255. */
export function frameDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  if (a.length !== b.length || a.length === 0) return 255;
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    const ga = a[i] * 0.299 + a[i + 1] * 0.587 + a[i + 2] * 0.114;
    const gb = b[i] * 0.299 + b[i + 1] * 0.587 + b[i + 2] * 0.114;
    sum += Math.abs(ga - gb);
  }
  return sum / (a.length / 4);
}

/** Decide whether to send this frame to vision. */
export function shouldAnalyze(diff: number, msSinceLast: number, inFlight: boolean): boolean {
  if (inFlight) return false;
  if (msSinceLast >= SAMPLING.heartbeatMs) return true;
  if (diff < SAMPLING.nearIdentical) return false;
  if (diff >= SAMPLING.major) return true;
  return msSinceLast >= (diff >= SAMPLING.active ? SAMPLING.activeIntervalMs : SAMPLING.idleIntervalMs);
}
