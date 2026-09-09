import type { RunState } from "../../../shared/types/run-state";
import { el } from "../dom/el";
import { wireGraphPan } from "./graph-pan";
import { renderGraph } from "./render-graph";

const ZOOM_MIN = 0.12;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 1.2;
const FIT_PAD = 28;

type ViewMode = "fit" | "original" | "manual";

type ViewState = {
  scale: number;
  mode: ViewMode;
};

const states = new Map<string, ViewState>();

function zoomLabel(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

function clampScale(scale: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
}

function svgSize(svg: SVGSVGElement): { w: number; h: number } {
  return {
    w: Number.parseFloat(svg.getAttribute("width") ?? "0"),
    h: Number.parseFloat(svg.getAttribute("height") ?? "0"),
  };
}

function fitScale(viewport: HTMLElement, w: number, h: number): number {
  if (w <= 0 || h <= 0) {
    return 1;
  }
  const availW = Math.max(1, viewport.clientWidth - FIT_PAD);
  const availH = Math.max(1, viewport.clientHeight - FIT_PAD);
  return clampScale(Math.min(availW / w, availH / h));
}

function applyTransform(
  scale: number,
  w: number,
  h: number,
  inner: HTMLElement,
  scaler: HTMLElement,
  label: HTMLElement,
): void {
  inner.style.width = `${w}px`;
  inner.style.height = `${h}px`;
  inner.style.transform = `scale(${scale})`;
  scaler.style.width = `${w * scale}px`;
  scaler.style.height = `${h * scale}px`;
  label.textContent = zoomLabel(scale);
}

function toolbarButton(label: string, text: string, onClick: () => void): HTMLButtonElement {
  const button = el("button", {
    class: "btn graph-tool",
    type: "button",
    text,
    title: label,
    "aria-label": label,
  });
  button.addEventListener("click", onClick);
  return button;
}

function wireWheelZoom(viewport: HTMLElement, onZoom: (factor: number) => void): void {
  viewport.addEventListener(
    "wheel",
    (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }
      event.preventDefault();
      onZoom(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    },
    { passive: false },
  );
}

/** Graph shell: toolbar (zoom/fit/100%) + viewport that fits the DAG to the screen by default. */
export function mountGraph(
  run: RunState,
  selectedId: string | null,
  onSelect: (nodeId: string) => void,
): HTMLElement {
  const shell = el("div", { class: "graph-shell" });
  if (run.nodes.length === 0) {
    shell.appendChild(
      el("div", { class: "graph graph-empty" }, [
        el("div", { class: "empty", text: "No nodes yet. Add some with dispatch.sh node add." }),
      ]),
    );
    return shell;
  }

  const svg = renderGraph(run, selectedId, onSelect);
  const { w, h } = svgSize(svg);

  const toolbar = el("div", { class: "graph-toolbar", role: "toolbar", "aria-label": "Graph zoom" });
  const zoomText = el("span", { class: "graph-zoom-label mono", text: "100%" });
  const viewport = el("div", { class: "graph", tabindex: "0", "aria-label": "Task graph viewport" });
  const scaler = el("div", { class: "graph-scaler" });
  const inner = el("div", { class: "graph-inner" });
  inner.appendChild(svg);
  scaler.appendChild(inner);
  viewport.appendChild(scaler);

  let state = states.get(run.run_id);
  if (state === undefined) {
    state = { scale: 1, mode: "fit" };
    states.set(run.run_id, state);
  }

  const sync = (): void => {
    applyTransform(state.scale, w, h, inner, scaler, zoomText);
  };

  const fitToView = (): void => {
    state.mode = "fit";
    state.scale = fitScale(viewport, w, h);
    sync();
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
  };

  const setOriginal = (): void => {
    state.mode = "original";
    state.scale = 1;
    sync();
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
  };

  const zoomBy = (factor: number): void => {
    state.mode = "manual";
    state.scale = clampScale(state.scale * factor);
    sync();
  };

  toolbar.append(
    toolbarButton("Zoom in", "+", () => zoomBy(ZOOM_STEP)),
    toolbarButton("Zoom out", "−", () => zoomBy(1 / ZOOM_STEP)),
    toolbarButton("Fit graph to screen", "Fit", fitToView),
    toolbarButton("Original size (100%)", "100%", setOriginal),
    zoomText,
    el("span", { class: "graph-hint muted", text: "Drag to pan · Ctrl+scroll to zoom" }),
  );

  shell.append(toolbar, viewport);

  if (state.mode === "fit") {
    fitToView();
    requestAnimationFrame(() => {
      fitToView();
    });
  } else {
    sync();
  }

  const observer = new ResizeObserver(() => {
    if (state.mode !== "fit") {
      return;
    }
    state.scale = fitScale(viewport, w, h);
    sync();
  });
  observer.observe(viewport);

  wireGraphPan(viewport);
  wireWheelZoom(viewport, zoomBy);

  return shell;
}
