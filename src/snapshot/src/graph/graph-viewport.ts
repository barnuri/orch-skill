import type { RunState } from "../../../shared/types/run-state";
import { el } from "../dom/el";
import { NODE_H, NODE_W, layoutDag } from "./dag-layout";
import { type Box, followView } from "./follow-view";
import { focusTarget } from "./focus-target";
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
  /** Follow what is running. On by default; any pan or zoom by the user turns it off. */
  follow: boolean;
  /** The node last scrolled to, so only a change of focus animates. */
  focused: string | null;
  /** Where the user left the graph, restored when the view is rebuilt for new data. */
  left: number;
  top: number;
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
  harnessByProfile: Record<string, string> = {},
  maxAttempts: number = 5,
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

  const svg = renderGraph(run, selectedId, onSelect, harnessByProfile, maxAttempts);
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
    state = { scale: 1, mode: "fit", follow: true, focused: null, left: 0, top: 0 };
    states.set(run.run_id, state);
  }
  const view = state;
  // Programmatic scrolls must not count as the user taking over.
  let programmatic = false;

  const target = focusTarget(run);
  const layout = layoutDag(run.nodes, run.edges);
  // The primary node first: followView centres on it when the others cannot all fit on screen.
  const boxes = (): Box[] => {
    if (target === null) {
      return [];
    }
    const ordered = [target.primary, ...target.nodeIds.filter((id) => id !== target.primary)];
    return ordered
      .map((id) => layout.pos[id])
      .filter((pos): pos is { x: number; y: number } => pos !== undefined)
      .map((pos) => ({ x: pos.x, y: pos.y, w: NODE_W, h: NODE_H }));
  };

  const scrollTo = (left: number, top: number, smooth: boolean): void => {
    programmatic = true;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    viewport.scrollTo({ left, top, behavior: smooth && !calm ? "smooth" : "auto" });
    view.left = left;
    view.top = top;
    setTimeout(() => {
      programmatic = false;
    }, smooth ? 600 : 50);
  };

  // Brings the focus into view: fitted when everything is readable at once, else zoomed and centred.
  const applyFollow = (smooth: boolean): void => {
    const next = followView({
      viewportW: viewport.clientWidth,
      viewportH: viewport.clientHeight,
      graphW: w,
      graphH: h,
      fitScale: fitScale(viewport, w, h),
      boxes: boxes(),
    });
    view.mode = next.fitsAll ? "fit" : "manual";
    view.scale = next.scale;
    sync();
    scrollTo(next.left, next.top, smooth && view.focused !== null && view.focused !== target?.primary);
    view.focused = target?.primary ?? null;
  };

  const stopFollowing = (): void => {
    if (!view.follow) {
      return;
    }
    view.follow = false;
    // From here the graph stays where the user puts it: a rebuild for new data restores this scale and
    // scroll instead of fitting again.
    if (view.mode === "fit") {
      view.mode = "manual";
    }
    followButton.setAttribute("aria-pressed", "false");
    followButton.classList.remove("is-on");
  };

  const sync = (): void => {
    applyTransform(state.scale, w, h, inner, scaler, zoomText);
  };

  // Placing the graph fitted is not the user taking over; only the Fit button is (below).
  const placeFit = (): void => {
    state.mode = "fit";
    state.scale = fitScale(viewport, w, h);
    sync();
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
  };
  const fitToView = (): void => {
    stopFollowing();
    placeFit();
  };

  const setOriginal = (): void => {
    stopFollowing();
    state.mode = "original";
    state.scale = 1;
    sync();
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
  };

  const zoomBy = (factor: number): void => {
    stopFollowing();
    state.mode = "manual";
    state.scale = clampScale(state.scale * factor);
    sync();
  };

  const followButton = toolbarButton(
    "Follow what is running: scrolls the graph to the node that is running now, or the next one to start",
    "Follow live",
    () => {
      view.follow = true;
      followButton.setAttribute("aria-pressed", "true");
      followButton.classList.add("is-on");
      view.focused = null;
      applyFollow(false);
    },
  );
  followButton.setAttribute("aria-pressed", String(view.follow));
  followButton.classList.toggle("is-on", view.follow);
  followButton.classList.add("graph-follow");

  toolbar.append(
    followButton,
    toolbarButton("Zoom in", "+", () => zoomBy(ZOOM_STEP)),
    toolbarButton("Zoom out", "−", () => zoomBy(1 / ZOOM_STEP)),
    toolbarButton("Fit graph to screen", "Fit", fitToView),
    toolbarButton("Original size (100%)", "100%", setOriginal),
    zoomText,
    el("span", { class: "graph-hint muted", text: target === null ? "Drag to pan · Ctrl+scroll to zoom" : `Following ${target.reason === "running" ? "what is running" : target.reason === "failed" ? "the failure" : "the next node"} · drag to look around` }),
  );

  shell.append(toolbar, viewport);

  if (view.follow && target !== null) {
    applyFollow(false);
    requestAnimationFrame(() => {
      applyFollow(true);
    });
  } else if (state.mode === "fit") {
    placeFit();
    requestAnimationFrame(() => {
      placeFit();
    });
  } else {
    sync();
    // The viewport is not in the page yet, and a detached element ignores scrolling: restore after attach.
    requestAnimationFrame(() => {
      scrollTo(view.left, view.top, false);
    });
  }

  const observer = new ResizeObserver(() => {
    if (view.follow && target !== null) {
      applyFollow(false);
      return;
    }
    if (state.mode !== "fit") {
      return;
    }
    state.scale = fitScale(viewport, w, h);
    sync();
  });
  observer.observe(viewport);

  // The user taking over (drag, wheel, touch) pauses following; a programmatic scroll does not.
  for (const type of ["mousedown", "touchstart", "wheel"] as const) {
    viewport.addEventListener(type, () => {
      if (!programmatic) {
        stopFollowing();
      }
    }, { passive: true });
  }
  viewport.addEventListener("scroll", () => {
    if (!programmatic) {
      view.left = viewport.scrollLeft;
      view.top = viewport.scrollTop;
    }
  }, { passive: true });

  wireGraphPan(viewport);
  wireWheelZoom(viewport, zoomBy);

  return shell;
}
