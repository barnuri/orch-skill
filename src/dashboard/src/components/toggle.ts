import { el } from "../dom/el";

/**
 * A switch for an on/off setting that applies at once. The label names what it controls, since
 * the control itself shows no text.
 */
export function toggle(label: string, on: boolean, onChange: (next: boolean) => void): HTMLButtonElement {
  const button = el("button", {
    class: "toggle",
    type: "button",
    role: "switch",
    "aria-checked": String(on),
    "aria-label": label,
    title: on ? "On" : "Off",
  });
  button.appendChild(el("span", { class: "toggle-track" }, [el("span", { class: "toggle-knob" })]));
  button.addEventListener("click", () => {
    onChange(!on);
  });
  return button;
}
