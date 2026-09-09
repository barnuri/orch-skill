import { el } from "../dom/el";

export type ConfirmOptions = {
  title: string;
  body: string;
  confirmLabel: string;
  danger: boolean;
};

const CANCEL_LABEL: string = "Cancel";

// The dashboard's replacement for the browser-native confirm popup (forbidden by the frontend guidelines): a modal
// <dialog> that names the target in `title`, the consequence in `body`, and puts the destructive
// action in the danger colour. Cancel is the default-focused button, Escape cancels, and the
// element removes itself on close so nothing accumulates in <body>.
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let confirmed = false;
    const cancel = el("button", { class: "btn", type: "button", autofocus: "", text: CANCEL_LABEL });
    const confirm = el("button", {
      class: options.danger ? "btn danger" : "btn primary",
      type: "button",
      text: options.confirmLabel,
    });
    const dialog = el("dialog", { class: "confirm" }, [
      el("h2", { text: options.title }),
      el("p", { text: options.body }),
      el("div", { class: "actions" }, [cancel, confirm]),
    ]);
    confirm.addEventListener("click", () => {
      confirmed = true;
      dialog.close();
    });
    cancel.addEventListener("click", () => {
      dialog.close();
    });
    // Every exit path (buttons, Escape → cancel → close) ends here, so the promise settles once.
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(confirmed);
    });
    document.body.appendChild(dialog);
    dialog.showModal();
    cancel.focus();
  });
}
