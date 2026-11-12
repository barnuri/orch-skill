import { el, svgEl } from "../dom/el";

const ENHANCED_ATTR = "data-enhanced";
const ACTIVE_ATTR = "data-active";

function chevron(): SVGElement {
  const svg = svgEl("svg", { class: "select-chevron", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", "stroke-width": "1.6", "aria-hidden": "true" });
  svg.appendChild(svgEl("path", { d: "m4 6 4 4 4-4", "stroke-linecap": "round", "stroke-linejoin": "round" }));
  return svg;
}

let openClose: (() => void) | null = null;

function closeOpen(): void {
  if (openClose !== null) {
    openClose();
  }
}

document.addEventListener("click", (event) => {
  if (openClose !== null && !(event.target instanceof Element && event.target.closest(".select"))) {
    closeOpen();
  }
});

/**
 * Replaces one native <select> with a styled listbox. The native element stays in the DOM,
 * hidden, so forms, `.value` reads and `change` listeners keep working unchanged.
 */
function enhance(select: HTMLSelectElement): void {
  select.setAttribute(ENHANCED_ATTR, "true");
  const wrap = el("div", { class: "select" });
  const button = el("button", { class: "select-btn", type: "button", "aria-haspopup": "listbox", "aria-expanded": "false" });
  const valueText = el("span", { class: "select-value" });
  button.append(valueText, chevron());
  const list = el("ul", { class: "select-list", role: "listbox", tabindex: "-1" });
  list.hidden = true;
  select.replaceWith(wrap);
  wrap.append(select, button, list);
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");
  if (select.id !== "") {
    button.setAttribute("aria-labelledby", `${select.id}`);
  }

  const options = (): HTMLOptionElement[] => Array.from(select.options);
  const rows: HTMLElement[] = [];
  let active = 0;

  const sync = (): void => {
    const current = options().find((option) => option.selected);
    valueText.textContent = current?.textContent ?? "";
    rows.forEach((row, index) => row.setAttribute("aria-selected", String(options()[index]?.selected === true)));
  };
  const highlight = (index: number): void => {
    active = Math.max(0, Math.min(rows.length - 1, index));
    rows.forEach((row, i) => row.setAttribute(ACTIVE_ATTR, String(i === active)));
    rows[active]?.scrollIntoView({ block: "nearest" });
  };
  const close = (): void => {
    list.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (openClose === close) {
      openClose = null;
    }
  };
  const choose = (index: number): void => {
    const option = options()[index];
    if (option !== undefined && !option.disabled) {
      select.value = option.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      sync();
    }
    close();
    button.focus();
  };
  const open = (): void => {
    closeOpen();
    list.hidden = false;
    button.setAttribute("aria-expanded", "true");
    openClose = close;
    highlight(Math.max(0, select.selectedIndex));
  };

  // Rebuilt whenever the native options change, so code that adds or removes options stays in sync.
  const buildRows = (): void => {
    rows.length = 0;
    list.replaceChildren();
    options().forEach((option, index) => {
      const row = el("li", { class: "select-opt", role: "option", text: option.textContent ?? "" });
      if (option.disabled) {
        row.setAttribute("aria-disabled", "true");
      }
      row.addEventListener("mousemove", () => highlight(index));
      row.addEventListener("click", () => choose(index));
      rows.push(row);
      list.appendChild(row);
    });
    sync();
  };
  buildRows();
  new MutationObserver(buildRows).observe(select, { childList: true, subtree: true, characterData: true });

  // Code that assigns `select.value` or `selectedIndex` directly fires no event, so the setters
  // are wrapped on this one element to refresh the visible value.
  for (const prop of ["value", "selectedIndex"] as const) {
    const native = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop);
    if (native?.get === undefined || native.set === undefined) {
      continue;
    }
    const { get, set } = native;
    Object.defineProperty(select, prop, {
      configurable: true,
      get(this: HTMLSelectElement) {
        return get.call(this);
      },
      set(this: HTMLSelectElement, next: never) {
        set.call(this, next);
        sync();
      },
    });
  }

  button.addEventListener("click", () => (list.hidden ? open() : close()));
  button.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (list.hidden) {
        open();
      } else {
        highlight(active + (event.key === "ArrowDown" ? 1 : -1));
      }
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      highlight(event.key === "Home" ? 0 : rows.length - 1);
    } else if ((event.key === "Enter" || event.key === " ") && !list.hidden) {
      event.preventDefault();
      choose(active);
    } else if (event.key === "Escape" && !list.hidden) {
      event.stopPropagation();
      close();
    }
  });
  sync();
}

/** Upgrades every native select under `root` that is not already upgraded. */
export function enhanceSelects(root: ParentNode): void {
  for (const select of root.querySelectorAll<HTMLSelectElement>(`select:not([${ENHANCED_ATTR}])`)) {
    enhance(select);
  }
}
