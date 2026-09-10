import type {
  ProfileSanityEnvelope,
  ProfileSanityResult,
  SanityStatus,
} from "../../../shared/types/profile-sanity";
import { ApiClient } from "../api/api-client";
import { el } from "../dom/el";
import { toast } from "../ui/toast";

const api = new ApiClient();

type SanityState = {
  running: boolean;
  data: ProfileSanityEnvelope | null;
  error: string | null;
};

const state: SanityState = { running: false, data: null, error: null };

function fmtMs(ms: number): string {
  if (ms < 1000) {
    return `${ms} ms`;
  }
  return `${(ms / 1000).toFixed(1)} s`;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * A single-profile probe returns only that profile, so replacing the envelope would blank the
 * table column for every other row. Fresh results win; older ones are kept.
 */
function mergeResults(
  previous: ProfileSanityEnvelope | null,
  incoming: ProfileSanityEnvelope,
): ProfileSanityEnvelope {
  if (previous === null) {
    return incoming;
  }
  const fresh = new Set(incoming.results.map((result) => result.profile));
  const kept = previous.results.filter((result) => !fresh.has(result.profile));
  return { generated_at: incoming.generated_at, results: [...incoming.results, ...kept] };
}

/** `unconfigured` is not a failure — counting it as one made a working setup look broken. */
function statusOf(result: ProfileSanityResult): SanityStatus {
  if (result.status !== undefined) {
    return result.status;
  }
  return result.ok ? "ok" : "failed";
}

const STATUS_LABELS: Readonly<Record<SanityStatus, string>> = {
  ok: "success",
  failed: "failure",
  unconfigured: "needs setup",
  disabled: "disabled",
  unknown: "unknown",
};

// Maps onto the chip colours already in the stylesheet.
const STATUS_CHIP: Readonly<Record<SanityStatus, string>> = {
  ok: "success",
  failed: "failure",
  unconfigured: "waiting",
  disabled: "skipped",
  unknown: "waiting",
};

function statusChip(status: SanityStatus): HTMLElement {
  return el("span", { class: `chip ${STATUS_CHIP[status]}`, text: STATUS_LABELS[status] });
}

// The chip labels a single row ("needs setup"); the summary counts rows, so it needs a phrase
// that reads correctly after a number for both 1 and many.
const STATUS_SUMMARY: Readonly<Record<SanityStatus, string>> = {
  ok: "passed",
  failed: "failed",
  unconfigured: "awaiting setup",
  disabled: "disabled",
  unknown: "unknown",
};

function summaryText(data: ProfileSanityEnvelope): string {
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

function resultRow(result: ProfileSanityResult): HTMLElement {
  const model = result.slug !== "" ? result.slug : result.model_id !== "" ? result.model_id : "—";
  return el("div", { class: "sanity-row", role: "row" }, [
    el("div", { class: "sanity-profile", text: result.profile }),
    statusChip(statusOf(result)),
    el("div", { class: "mono", text: result.harness }),
    el("div", { class: "mono", text: model }),
    el("div", { class: "sanity-ms", text: fmtMs(result.ms) }),
    el("div", { class: "muted", text: fmtBytes(result.bytes) }),
    el("div", { class: "sanity-error muted", text: result.error || "—" }),
  ]);
}

export function renderSanityPanel(): HTMLElement | null {
  if (state.running) {
    return el("div", { class: "sanity-panel", role: "status" }, [
      el("h2", { text: "Sanity test" }),
      el("p", { class: "muted", text: "Running probes… this may take a minute per profile." }),
    ]);
  }
  if (state.error !== null) {
    return el("div", { class: "sanity-panel" }, [
      el("h2", { text: "Sanity test" }),
      el("div", { class: "notice", text: state.error }),
    ]);
  }
  if (state.data === null) {
    return null;
  }
  const header = el("div", { class: "sanity-head" }, [
    el("h2", { text: "Sanity test" }),
    el("div", { class: "muted", text: summaryText(state.data) }),
  ]);
  const list = el("div", { class: "sanity-list", role: "table" }, [
    el("div", { class: "sanity-row head", role: "row" }, [
      el("div", { text: "Profile" }),
      el("div", { text: "Status" }),
      el("div", { text: "Harness" }),
      el("div", { text: "Model" }),
      el("div", { text: "Latency" }),
      el("div", { text: "Response" }),
      el("div", { text: "Error" }),
    ]),
  ]);
  for (const result of state.data.results) {
    list.appendChild(resultRow(result));
  }
  return el("div", { class: "sanity-panel" }, [header, list]);
}

export function sanityRunning(): boolean {
  return state.running;
}

/** The classified outcome of a result, used by the panel and the profiles table alike. */
export function sanityStatusOf(result: ProfileSanityResult): SanityStatus {
  return statusOf(result);
}

/** The chip for a classified outcome, so the table and the panel read identically. */
export function sanityStatusChip(status: SanityStatus): HTMLElement {
  return statusChip(status);
}

/** The last probe result for one profile, or null when it has not been tested this session. */
export function sanityFor(profile: string): ProfileSanityResult | null {
  return state.data?.results.find((result) => result.profile === profile) ?? null;
}

export function runProfileSanity(profiles: string[] | undefined, onDone: () => void): void {
  if (state.running) {
    return;
  }
  state.running = true;
  state.error = null;
  onDone();
  void api
    .profileSanity(profiles)
    .then((result) => {
      state.running = false;
      if (result.kind === "ok") {
        state.data = mergeResults(state.data, result.body);
        state.error = null;
        const failed = result.body.results.filter((r) => statusOf(r) === "failed").length;
        const unconfigured = result.body.results.filter((r) => statusOf(r) === "unconfigured").length;
        if (failed > 0) {
          toast("error", `${failed} profile(s) failed`);
        } else if (unconfigured > 0) {
          toast("ok", `All configured profiles passed · ${unconfigured} not configured`);
        } else {
          toast("ok", "All profiles passed");
        }
      } else if (result.kind === "error") {
        state.error = result.body?.error ?? "Sanity test failed";
      } else {
        state.error = "Sanity test failed";
      }
      onDone();
    })
    .catch(() => {
      state.running = false;
      state.error = "Sanity test failed";
      onDone();
    });
}

export function sanityTestButton(label: string, profiles: string[] | undefined, onDone: () => void): HTMLButtonElement {
  const button = el("button", { class: "btn", type: "button", text: label });
  button.disabled = state.running;
  button.addEventListener("click", () => {
    runProfileSanity(profiles, onDone);
  });
  return button;
}
