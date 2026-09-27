// Strips obvious secrets and PII before anything is written to permanent memory.
// ponytail: regex heuristics, not a DLP engine; swap for a real classifier if inputs broaden beyond vision captions.
const RULES: [RegExp, string][] = [
  [/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}\b/g, "[REDACTED_KEY]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_KEY]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED_KEY]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_TOKEN]"],
  [/\b(?:password|passwd|pwd|api[_ -]?key|secret|token)\s*[:=]\s*\S+/gi, "[REDACTED_SECRET]"],
  [/\b(?:\d[ -]?){13,19}\b/g, "[REDACTED_NUMBER]"], // card-like digit runs
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED_SSN]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]"],
  [/\+?\d{1,3}[ .-]?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g, "[REDACTED_PHONE]"],
];

export function redact(text: string): string {
  return RULES.reduce((t, [re, sub]) => t.replace(re, sub), text);
}
