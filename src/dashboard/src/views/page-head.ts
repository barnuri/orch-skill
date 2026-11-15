import { el } from "../dom/el";

/** Consistent page title block: heading, subtitle, optional right-side toolbar. */
export function pageHead(title: string, subtitle: string, toolbar?: Node): HTMLElement {
  const titles = el("div", { class: "titles" }, [
    el("h1", { text: title }),
    el("p", { class: "sub", text: subtitle }),
  ]);
  const head = el("div", { class: "page-head" }, [titles]);
  if (toolbar !== undefined) {
    head.appendChild(el("div", { class: "toolbar" }, [toolbar]));
  }
  return head;
}
