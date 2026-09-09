import { el } from "../dom/el";

const INPUT_ID: string = "token-input";

// Shown whenever the API answers 401. Polling keeps running, so a correct token clears the
// gate on the next tick even without pressing Continue.
export function renderTokenGate(onSubmit: (token: string) => void): HTMLElement {
  const input = el("input", {
    id: INPUT_ID,
    type: "password",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "Paste the token printed by dispatch.sh ui",
  });
  const form = el("form", { class: "form" }, [
    el("div", { class: "field" }, [el("label", { for: INPUT_ID, text: "Token" }), input]),
    el("div", {}, [el("button", { class: "btn primary", type: "submit", text: "Continue" })]),
  ]);
  form.addEventListener("submit", (event: SubmitEvent) => {
    // Never navigates (the CSP forbids form-action anyway); the token goes to localStorage.
    event.preventDefault();
    const token = input.value.trim();
    if (token === "") {
      input.focus();
      return;
    }
    onSubmit(token);
  });
  return el("section", { class: "token-gate" }, [
    el("h1", { text: "Token required" }),
    el("p", { class: "sub", text: "This dashboard only talks to the server with the bearer token it printed on start." }),
    form,
  ]);
}
