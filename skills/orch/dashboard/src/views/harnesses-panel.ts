import type { HarnessStatus } from "../../../shared/types/harness-status";
import type { ProfilesDocument } from "../../../shared/types/profiles-document";
import { ApiClient } from "../api/api-client";
import { el } from "../dom/el";
import { harnessMarkIcon } from "../graph/harness-mark";
import { saveDoc } from "../forms/document-editor";
import { deepCopy } from "../forms/field-issues";
import { render } from "../render";
import type { AppState } from "../state/app-state";
import { state } from "../state/state";

const api = new ApiClient();

const busyToggles: Set<string> = new Set();

function statusChip(harness: HarnessStatus): HTMLElement {
  if (!harness.wired) {
    return el("span", {
      class: harness.available ? "chip done" : "chip waiting",
      text: harness.available ? "detected" : "missing",
    });
  }
  if (!harness.enabled) {
    return el("span", { class: "chip default", text: "disabled" });
  }
  if (harness.available) {
    // The `done` class carries the green dot; a harness is "ready", not "done".
    return el("span", { class: "chip done", text: "ready" });
  }
  return el("span", { class: "chip waiting", text: "missing" });
}

export function harnessCard(
  harness: HarnessStatus,
  loaded: ProfilesDocument | null,
  etag: string,
): HTMLElement {
  // A dispatchable harness gets its glyph in the accent colour; everything else stays muted.
  const ready = harness.wired && harness.enabled && harness.available;
  const card = el("article", { class: ready ? "harness-card is-ready" : "harness-card" });
  const head = el("div", { class: "harness-head" }, [
    el("span", { class: "harness-logo" }, [harnessMarkIcon(harness.id, 18)]),
    el("h3", { class: "harness-title mono", text: harness.id }),
    statusChip(harness),
    el("span", { class: "muted", text: harness.kind }),
    harness.wired ? null : el("span", { class: "muted", text: "not wired" }),
  ]);
  card.appendChild(head);
  card.appendChild(el("p", { class: "harness-desc", text: harness.description }));
  if (harness.binary !== null) {
    card.appendChild(el("p", { class: "hint mono", text: `binary: ${harness.binary}` }));
  }
  if (harness.needs.length > 0) {
    card.appendChild(el("p", { class: "hint", text: `needs: ${harness.needs.join(", ")}` }));
  }
  if (!harness.available && harness.reason !== "") {
    card.appendChild(el("p", { class: "harness-reason", text: harness.reason }));
  }

  if (harness.wired && loaded !== null) {
    const toggle = el("button", {
      class: "btn",
      type: "button",
      text: harness.enabled ? "Disable in UI" : "Enable in UI",
    });
    toggle.disabled = busyToggles.has(harness.id);
    toggle.addEventListener("click", () => {
      void toggleHarness(harness.id, !harness.enabled, loaded, etag, toggle);
    });
    card.appendChild(el("div", { class: "harness-actions" }, [toggle]));
  }
  return card;
}

async function toggleHarness(
  id: string,
  enabled: boolean,
  loaded: ProfilesDocument,
  etag: string,
  button: HTMLButtonElement,
): Promise<void> {
  busyToggles.add(id);
  button.disabled = true;
  const next = deepCopy(loaded);
  const disabled = new Set(next.settings.disabled_harnesses ?? []);
  if (enabled) {
    disabled.delete(id);
  } else {
    disabled.add(id);
  }
  if (disabled.size === 0) {
    delete next.settings.disabled_harnesses;
  } else {
    next.settings.disabled_harnesses = [...disabled].sort((a, b) => a.localeCompare(b));
  }
  await saveDoc("profiles", next, button);
  busyToggles.delete(id);
  await refreshHarnesses();
}

export async function refreshHarnesses(): Promise<void> {
  const result = await api.getHarnesses();
  if (result.kind === "ok") {
    state.harnesses = result.body.harnesses;
    state.harnessesError = null;
    render();
    return;
  }
  if (result.kind === "unchanged" && state.harnesses !== null) {
    return;
  }
  state.harnesses = null;
  if (result.kind === "network") {
    state.harnessesError = "could not reach the dashboard";
  } else if (result.kind === "error") {
    state.harnessesError = result.body?.error ?? `harness probe failed (${result.status})`;
  } else {
    state.harnessesError = "harness probe failed";
  }
  render();
}

