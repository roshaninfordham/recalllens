"use client";

export const CONSENT_KEY = "recalllens.consent_id";

export function consentId(): string | null {
  try {
    return localStorage.getItem(CONSENT_KEY);
  } catch {
    return null;
  }
}

/** fetch wrapper that attaches the consent receipt id and surfaces server errors as exceptions. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", "x-consent-id": consentId() ?? "", ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

export const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}
