import type { ProfileSanityEnvelope, ProfileSanityResult, SanityStatus } from "../../shared/types/profile-sanity";

export const fmtMs = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
export const fmtBytes = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

/** `unconfigured` is not a failure: counting it as one made a working setup look broken. */
export function statusOf(result: ProfileSanityResult): SanityStatus {
  return result.status ?? (result.ok ? "ok" : "failed");
}

export const STATUS_LABELS: Readonly<Record<SanityStatus, string>> = {
  ok: "success",
  failed: "failure",
  unconfigured: "needs setup",
  disabled: "disabled",
  unknown: "unknown",
};

// Maps onto the chip colours already in the stylesheet.
export const STATUS_CHIP: Readonly<Record<SanityStatus, string>> = {
  ok: "success",
  failed: "failure",
  unconfigured: "waiting",
  disabled: "skipped",
  unknown: "waiting",
};

const STATUS_SUMMARY: Readonly<Record<SanityStatus, string>> = {
  ok: "passed",
  failed: "failed",
  unconfigured: "awaiting setup",
  disabled: "disabled",
  unknown: "unknown",
};

/** A single-profile probe returns only that profile: fresh results win, older ones are kept. */
export function mergeResults(previous: ProfileSanityEnvelope | null, incoming: ProfileSanityEnvelope): ProfileSanityEnvelope {
  if (previous === null) {
    return incoming;
  }
  const fresh = new Set(incoming.results.map((result) => result.profile));
  const kept = previous.results.filter((result) => !fresh.has(result.profile));
  return { generated_at: incoming.generated_at, results: [...incoming.results, ...kept] };
}

export function summaryText(data: ProfileSanityEnvelope): string {
  const counts = new Map<SanityStatus, number>();
  for (const result of data.results) {
    const status = statusOf(result);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const total = data.results.length;
  const ms = data.results.reduce((sum, r) => sum + r.ms, 0);
  const parts = [`${counts.get("ok") ?? 0}/${total} passed`];
  for (const status of ["failed", "unconfigured", "disabled", "unknown"] as const) {
    const count = counts.get(status) ?? 0;
    if (count > 0) {
      parts.push(`${count} ${STATUS_SUMMARY[status]}`);
    }
  }
  parts.push(`total ${fmtMs(ms)}`);
  return parts.join(" · ");
}

export function sanityToast(data: ProfileSanityEnvelope): { kind: "ok" | "error"; text: string } {
  const failed = data.results.filter((r) => statusOf(r) === "failed").length;
  const unconfigured = data.results.filter((r) => statusOf(r) === "unconfigured").length;
  if (failed > 0) {
    return { kind: "error", text: `${failed} profile(s) failed` };
  }
  if (unconfigured > 0) {
    return { kind: "ok", text: `All configured profiles passed · ${unconfigured} not configured` };
  }
  return { kind: "ok", text: "All profiles passed" };
}
