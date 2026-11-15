import type { Issue } from "../../../shared/types/issue";
import { el } from "../dom/el";
import { longestPathMatch } from "./field-issues";

export type FieldControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const DATA_PATH_ATTR: string = "data-path";
const FIELD_SELECTOR: string = ".field";
const FIELD_ERROR_SELECTOR: string = ".field-error";
const ARIA_INVALID: string = "aria-invalid";
const ID_PREFIX: string = "field-";
const NON_ID_CHARS = /[^A-Za-z0-9_-]+/g;

function idFor(path: string): string {
  return `${ID_PREFIX}${path.replace(NON_ID_CHARS, "-")}`;
}

// `.field` row: label wired to the control by id, control tagged with the document path the
// server reports issues against (`profiles.<n>.flags`, `memory[3].outcome`, …).
export function fieldRow(label: string, control: FieldControl, path: string): HTMLElement {
  if (control.id === "") {
    control.id = idFor(path);
  }
  control.setAttribute(DATA_PATH_ATTR, path);
  return el("div", { class: "field" }, [el("label", { for: control.id, text: label }), control]);
}

function clearFieldIssues(root: ParentNode): void {
  for (const stale of root.querySelectorAll(FIELD_ERROR_SELECTOR)) {
    stale.remove();
  }
  for (const control of root.querySelectorAll(`[${ARIA_INVALID}]`)) {
    control.removeAttribute(ARIA_INVALID);
  }
}

// What the message says under the control: the part of the issue path below the field (`FOO`
// for an env key, `[2]` for a flag line) so a one-per-line textarea tells the user which line.
function reasonFor(issue: Issue, fieldPath: string): string {
  const rest = issue.path.startsWith(fieldPath) ? issue.path.slice(fieldPath.length) : "";
  const sub = rest.startsWith(".") ? rest.slice(1) : rest;
  return sub === "" ? issue.reason : `${sub}: ${issue.reason}`;
}

// Places each issue under the control whose data-path covers it (see longestPathMatch) and
// returns the ones no control claims — the caller lists those at the top of the form. Safe to
// call again on the same root: previous markers are cleared first.
export function attachFieldIssues(root: ParentNode, issues: readonly Issue[]): Issue[] {
  clearFieldIssues(root);
  const controls = new Map<string, Element>();
  for (const control of root.querySelectorAll(`[${DATA_PATH_ATTR}]`)) {
    controls.set(control.getAttribute(DATA_PATH_ATTR) ?? "", control);
  }
  const paths = [...controls.keys()];
  const unmatched: Issue[] = [];
  for (const issue of issues) {
    const fieldPath = longestPathMatch(paths, issue.path);
    const control = fieldPath === null ? undefined : controls.get(fieldPath);
    if (fieldPath === null || control === undefined) {
      unmatched.push(issue);
      continue;
    }
    control.setAttribute(ARIA_INVALID, "true");
    const message = el("div", { class: "field-error", text: reasonFor(issue, fieldPath) });
    const row = control.closest(FIELD_SELECTOR);
    if (row === null) {
      control.after(message);
    } else {
      row.appendChild(message);
    }
  }
  return unmatched;
}
