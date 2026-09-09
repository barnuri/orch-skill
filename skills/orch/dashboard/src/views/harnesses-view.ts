import type { ProfilesDocument } from "../../../shared/types/profiles-document";
import { el } from "../dom/el";
import type { AppState } from "../state/app-state";
import { harnessCard, refreshHarnesses } from "./harnesses-panel";
import { pageHead } from "./page-head";

/** The `#/harnesses` page: probed adapters and other detected agent CLIs on this machine. */
export function renderHarnesses(state: AppState): DocumentFragment {
  const doc = state.doc?.kind === "profiles" ? state.doc : null;
  const loaded =
    doc !== null && doc.document !== null && "profiles" in doc.document
      ? (doc.document as ProfilesDocument)
      : null;
  const etag = doc?.etag ?? "";
  const frag = document.createDocumentFragment();
  const refresh = el("button", { class: "btn", type: "button", text: "Re-detect" });
  refresh.addEventListener("click", () => {
    void refreshHarnesses();
  });
  const wired = state.harnesses?.filter((h) => h.wired).length ?? 0;
  const detected = state.harnesses?.filter((h) => !h.wired && h.available).length ?? 0;
  const sub =
    state.harnesses === null
      ? "Probing this machine…"
      : `${wired} orch adapters · ${detected} other CLI${detected === 1 ? "" : "s"} detected`;
  frag.appendChild(pageHead("Harnesses", sub, refresh));

  if (state.harnessesError !== null) {
    frag.appendChild(el("div", { class: "notice", text: state.harnessesError }));
    return frag;
  }
  if (state.harnesses === null) {
    frag.appendChild(el("div", { class: "sub", text: "Detecting harnesses…" }));
    void refreshHarnesses();
    return frag;
  }

  frag.appendChild(
    el("p", {
      class: "sub harness-intro",
      text: "Wired adapters can be used in profiles. Other CLIs are auto-detected for visibility — orch does not dispatch to them yet.",
    }),
  );

  const wiredSection = el("section", { class: "harness-section" });
  wiredSection.appendChild(el("h2", { text: "Orch adapters" }));
  const wiredGrid = el("div", { class: "harness-grid" });
  for (const harness of state.harnesses.filter((h) => h.wired)) {
    wiredGrid.appendChild(harnessCard(harness, loaded, etag));
  }
  wiredSection.appendChild(wiredGrid);
  frag.appendChild(wiredSection);

  const extra = state.harnesses.filter((h) => !h.wired);
  if (extra.length > 0) {
    const extraSection = el("section", { class: "harness-section" });
    extraSection.appendChild(el("h2", { text: "Detected CLIs" }));
    const extraGrid = el("div", { class: "harness-grid" });
    for (const harness of extra) {
      extraGrid.appendChild(harnessCard(harness, loaded, etag));
    }
    extraSection.appendChild(extraGrid);
    frag.appendChild(extraSection);
  }

  return frag;
}
