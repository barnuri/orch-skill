import { el } from "../dom/el";

export interface SegmentedOption {
  value: string;
  label: string;
}

/**
 * A flat radio group for a short list of views or ranges. Arrow keys move the choice, so the
 * group is one tab stop, like a native radio group.
 */
export function segmented(
  label: string,
  value: string,
  options: readonly SegmentedOption[],
  onChange: (next: string) => void,
): HTMLElement {
  const group = el("div", { class: "seg", role: "radiogroup", "aria-label": label });
  const buttons: HTMLButtonElement[] = [];
  for (const option of options) {
    const checked = option.value === value;
    const button = el("button", {
      class: "seg-opt",
      type: "button",
      role: "radio",
      "aria-checked": String(checked),
      tabindex: checked ? "0" : "-1",
      text: option.label,
    });
    button.addEventListener("click", () => {
      if (option.value !== value) {
        onChange(option.value);
      }
    });
    button.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
      if (step === 0) {
        return;
      }
      event.preventDefault();
      const next = options[(options.indexOf(option) + step + options.length) % options.length];
      if (next !== undefined) {
        onChange(next.value);
      }
    });
    buttons.push(button);
    group.appendChild(button);
  }
  return group;
}

/** A labelled field wrapper for a control that has no native label of its own. */
export function labelled(label: string, control: HTMLElement): HTMLElement {
  return el("div", { class: "field-group" }, [el("span", { class: "field-label", text: label }), control]);
}
