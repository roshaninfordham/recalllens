// Confidence policy shared by the agent tools and tests. Thresholds per product spec:
// ≥0.90 strong, 0.70–0.89 moderate, <0.70 uncertain.
export type Band = "strong" | "moderate" | "uncertain";

export const band = (c: number): Band => (c >= 0.9 ? "strong" : c >= 0.7 ? "moderate" : "uncertain");

/** Newest observation that is trustworthy (≥0.7); falls back to the newest if none is. Input must be newest-first. */
export function latestTrustworthy<T extends { confidence: number }>(obs: T[]): T | undefined {
  return obs.find((o) => o.confidence >= 0.7) ?? obs[0];
}
