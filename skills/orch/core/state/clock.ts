// Clock helpers. Same text as lib/core/config.sh now_iso: UTC, whole seconds, `Z` suffix.

export function nowIso(d: Date = new Date()): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Epoch seconds of an ISO instant, or null when it does not parse.
export function epochOf(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}
