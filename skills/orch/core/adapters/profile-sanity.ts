// Profile sanity probes. Ported from lib/adapters/profile-sanity.sh, partially: the `unknown` and
// `disabled` statuses. The probe itself (env load, harness spawn, latency) is not ported yet.
// Bun built-ins only.
import type { Catalog } from "./routing.ts";
import { hasHarnessDisabled } from "./routing.ts";

export type SanityRow = { profile: string; ok: boolean; status: string; ms: number; harness: string; model_id: string; slug: string; exit_code: number; bytes: number; error: string };

// One profile's sanity row without spawning a harness. Returns null when the profile needs the
// unported probe (load and spawn).
export function profileSanityStatic(cat: Catalog, name: string): SanityRow | null {
  const prof = cat.profiles?.[name];
  const base = { profile: name, ok: false, ms: 0, model_id: "", slug: "", bytes: 0 };
  if (!prof) return { ...base, status: "unknown", harness: "", exit_code: 2, error: "unknown profile", };
  const harness = prof.harness ?? "";
  if (prof.enabled === false || hasHarnessDisabled(cat, harness)) {
    return { ...base, status: "disabled", harness, exit_code: 0, error: prof.enabled === false ? "profile disabled" : "harness disabled" };
  }
  return null;
}
