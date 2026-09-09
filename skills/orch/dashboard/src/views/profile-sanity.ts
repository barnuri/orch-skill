import type { ProfileSanityEnvelope, ProfileSanityResult } from "../../../shared/types/profile-sanity";
import { ApiClient } from "../api/api-client";
import { chip, el } from "../dom/el";
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

function summaryText(data: ProfileSanityEnvelope): string {
  const ok = data.results.filter((r) => r.ok).length;
  const total = data.results.length;
  const ms = data.results.reduce((sum, r) => sum + r.ms, 0);
  return `${ok}/${total} passed · total ${fmtMs(ms)} · ${data.generated_at}`;
}

function resultRow(result: ProfileSanityResult): HTMLElement {
  const model = result.slug !== "" ? result.slug : result.model_id !== "" ? result.model_id : "—";
  return el("div", { class: "sanity-row", role: "row" }, [
    el("div", { class: "sanity-profile", text: result.profile }),
    chip(result.ok ? "success" : "failure"),
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
        const failed = result.body.results.filter((r) => !r.ok).length;
        toast(failed === 0 ? "ok" : "error", failed === 0 ? "All profiles passed" : `${failed} profile(s) failed`);
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
