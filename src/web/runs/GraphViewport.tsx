import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef } from "react";
import type { RunState } from "../../shared/types/run-state";
import type { RunNode } from "../../shared/types/run-node";
import { NODE_H, NODE_W, layoutDag } from "../lib/dag-layout";
import { followView } from "../lib/follow-view";
import type { Box } from "../lib/follow-view";
import { focusTarget } from "../lib/focus-target";
import { GRAPH_SCALE_SAVE_MS, ZOOM_MAX, ZOOM_MIN } from "../lib/constants";
import { clampZoom, loadGraphPrefs, saveGraphFollow, saveGraphHideDone, saveGraphMode, saveGraphScale } from "../lib/graph-prefs";
import type { GraphViewMode } from "../lib/graph-prefs";
import { GraphSvg } from "./GraphSvg";

const ZOOM_STEP = 1.2;
const FIT_PAD = 28;
const DRAG_PX = 4;

interface ViewState {
  scale: number;
  mode: GraphViewMode;
  /** Follow what is running. On by default; any pan or zoom by the user turns it off. */
  follow: boolean;
  /** Hide finished nodes (the selected one stays). */
  hideDone: boolean;
  /** The node last scrolled to, so only a change of focus animates. */
  focused: string | null;
  /** Where the user left the graph. */
  left: number;
  top: number;
}

// Per run, kept for the tab's life: leaving a run and coming back keeps the user's choice.
const states = new Map<string, ViewState>();

export function viewStateFor(runId: string): ViewState {
  let state = states.get(runId);
  if (state === undefined) {
    // Zoom, mode, Follow and Hide done start from the last choice made on any run.
    const prefs = loadGraphPrefs();
    // 100% is always exactly 1; fit and manual keep the stored scale (fit recomputes it from the data).
    const scale = prefs.mode === "original" ? 1 : prefs.scale;
    state = { scale, mode: prefs.mode, follow: prefs.follow, hideDone: prefs.hideDone, focused: null, left: 0, top: 0 };
    states.set(runId, state);
  }
  return state;
}

export function clearViewStates(): void {
  states.clear();
}

const clampScale = (scale: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));

// One pending zoom write, shared by every run: the last scale wins after a quiet GRAPH_SCALE_SAVE_MS.
let scaleSave: ReturnType<typeof setTimeout> | null = null;
function recordZoom(scale: number): void {
  if (scaleSave !== null) {
    clearTimeout(scaleSave);
  }
  scaleSave = setTimeout(() => {
    scaleSave = null;
    saveGraphScale(clampZoom(scale));
  }, GRAPH_SCALE_SAVE_MS);
}

/** Nodes the Hide done toggle removes from the graph: finished and skipped ones. */
const isHiddenByToggle = (status: string): boolean => status === "done" || status === "skipped";

function fitScale(viewport: HTMLElement, w: number, h: number): number {
  if (w <= 0 || h <= 0) {
    return 1;
  }
  const availW = Math.max(1, viewport.clientWidth - FIT_PAD);
  const availH = Math.max(1, viewport.clientHeight - FIT_PAD);
  return clampScale(Math.min(availW / w, availH / h));
}

function hintText(reason: string | null): string {
  if (reason === null) {
    return "Drag to pan · Ctrl+scroll to zoom";
  }
  const what = reason === "running" ? "what is running" : reason === "failed" ? "the failure" : "the next node";
  return `Following ${what} · drag to look around`;
}

interface Props {
  run: RunState;
  selectedId: string | null;
  onSelect: (nodeId: string) => void;
  harnessByProfile: Record<string, string>;
  maxAttempts: number;
  /** The run page's node filter; nodes it rejects are left out of the graph (the selected one stays). */
  match?: ((node: RunNode) => boolean) | null;
}

/** Toolbar (follow, zoom, fit, 100%) and a pannable viewport that fits the DAG to the screen by default. */
export function GraphViewport({ run, selectedId, onSelect, harnessByProfile, maxAttempts, match = null }: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const view = viewStateFor(run.run_id);
  // Programmatic scrolls must not count as the user taking over.
  const programmatic = useRef(false);
  const calm = useRef<ReturnType<typeof setTimeout> | null>(null);

  const shown = useMemo((): RunState => {
    if (!view.hideDone && match === null) {
      return run;
    }
    const nodes = run.nodes.filter(
      (node) => node.id === selectedId || ((!view.hideDone || !isHiddenByToggle(node.status)) && (match === null || match(node))),
    );
    const ids = new Set(nodes.map((node) => node.id));
    return { ...run, nodes, edges: run.edges.filter(([from, to]) => ids.has(from) && ids.has(to)) };
  }, [run, selectedId, view.hideDone, match]);
  const hiddenCount = run.nodes.filter((node) => isHiddenByToggle(node.status)).length;
  const layout = useMemo(() => layoutDag(shown.nodes, shown.edges), [shown]);
  const target = useMemo(() => focusTarget(run), [run]);
  const w = layout.width;
  const hasNodes = run.nodes.length > 0;
  const h = layout.height;

  const boxes = useCallback((): Box[] => {
    if (target === null) {
      return [];
    }
    const ordered = [target.primary, ...target.nodeIds.filter((id) => id !== target.primary)];
    return ordered
      .map((id) => layout.pos[id])
      .filter((pos): pos is { x: number; y: number } => pos !== undefined)
      .map((pos) => ({ x: pos.x, y: pos.y, w: NODE_W, h: NODE_H }));
  }, [target, layout]);

  const scrollTo = useCallback(
    (left: number, top: number, smooth: boolean): void => {
      const node = viewport.current;
      if (node === null) {
        return;
      }
      programmatic.current = true;
      const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
      if (typeof node.scrollTo === "function") {
        node.scrollTo({ left, top, behavior: smooth && !still ? "smooth" : "auto" });
      } else {
        node.scrollLeft = left;
        node.scrollTop = top;
      }
      view.left = left;
      view.top = top;
      if (calm.current !== null) {
        clearTimeout(calm.current);
      }
      calm.current = setTimeout(
        () => {
          programmatic.current = false;
        },
        smooth ? 600 : 50,
      );
    },
    [view],
  );

  // Brings the focus into view: fitted when everything is readable at once, else zoomed and centred.
  const applyFollow = useCallback(
    (smooth: boolean): void => {
      const node = viewport.current;
      if (node === null) {
        return;
      }
      const next = followView({
        viewportW: node.clientWidth,
        viewportH: node.clientHeight,
        graphW: w,
        graphH: h,
        fitScale: fitScale(node, w, h),
        boxes: boxes(),
      });
      view.mode = next.fitsAll ? "fit" : "manual";
      view.scale = next.scale;
      redraw();
      scrollTo(next.left, next.top, smooth && view.focused !== null && view.focused !== target?.primary);
      view.focused = target?.primary ?? null;
    },
    [boxes, h, scrollTo, target, view, w],
  );

  const placeFit = useCallback((): void => {
    const node = viewport.current;
    if (node === null) {
      return;
    }
    view.mode = "fit";
    view.scale = fitScale(node, w, h);
    redraw();
    node.scrollLeft = 0;
    node.scrollTop = 0;
  }, [h, view, w]);

  // Data refresh: keep following, or keep the fitted view fitted. A manual view is left where the
  // user put it (the viewport element survives the refresh, so its scroll position does too).
  useLayoutEffect(() => {
    if (view.follow && target !== null) {
      applyFollow(false);
      const frame = requestAnimationFrame(() => {
        applyFollow(true);
      });
      return () => {
        cancelAnimationFrame(frame);
      };
    }
    if (view.mode === "fit") {
      placeFit();
      const frame = requestAnimationFrame(placeFit);
      return () => {
        cancelAnimationFrame(frame);
      };
    }
    const frame = requestAnimationFrame(() => {
      scrollTo(view.left, view.top, false);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [applyFollow, placeFit, scrollTo, target, view]);

  useEffect(() => {
    const node = viewport.current;
    if (node === null || typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const observer = new ResizeObserver(() => {
      if (view.follow && target !== null) {
        applyFollow(false);
        return;
      }
      if (view.mode === "fit") {
        view.scale = fitScale(node, w, h);
        redraw();
      }
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [applyFollow, h, hasNodes, target, view, w]);

  // Drag on empty canvas pans; the user taking over (drag, wheel, touch) pauses following.
  useEffect(() => {
    const node = viewport.current;
    if (node === null) {
      return undefined;
    }
    const stopFollowing = (): void => {
      if (!view.follow) {
        return;
      }
      view.follow = false;
      saveGraphFollow(false);
      // From here the graph stays where the user puts it instead of fitting again.
      if (view.mode === "fit") {
        view.mode = "manual";
        saveGraphMode(view.mode);
      }
      redraw();
    };
    const taking = (): void => {
      if (!programmatic.current) {
        stopFollowing();
      }
    };
    const onScroll = (): void => {
      if (!programmatic.current) {
        view.left = node.scrollLeft;
        view.top = node.scrollTop;
      }
    };
    let active = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let scrollLeft = 0;
    let scrollTop = 0;
    const onMove = (event: MouseEvent): void => {
      if (!active) {
        return;
      }
      const dx = event.pageX - startX;
      const dy = event.pageY - startY;
      if (!moved && Math.abs(dx) < DRAG_PX && Math.abs(dy) < DRAG_PX) {
        return;
      }
      moved = true;
      node.scrollLeft = scrollLeft - dx;
      node.scrollTop = scrollTop - dy;
      event.preventDefault();
    };
    const onUp = (): void => {
      if (!active) {
        return;
      }
      active = false;
      node.classList.remove("panning");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    const onDown = (event: MouseEvent): void => {
      taking();
      if (event.button !== 0 || !(event.target instanceof Element) || event.target.closest(".node") !== null) {
        return;
      }
      active = true;
      moved = false;
      startX = event.pageX;
      startY = event.pageY;
      scrollLeft = node.scrollLeft;
      scrollTop = node.scrollTop;
      node.classList.add("panning");
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };
    const onWheel = (event: WheelEvent): void => {
      taking();
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    };
    const zoomBy = (factor: number): void => {
      stopFollowing();
      view.mode = "manual";
      view.scale = clampScale(view.scale * factor);
      saveGraphMode(view.mode);
      recordZoom(view.scale);
      redraw();
    };
    node.addEventListener("mousedown", onDown);
    node.addEventListener("touchstart", taking, { passive: true });
    node.addEventListener("wheel", onWheel, { passive: false });
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      node.removeEventListener("mousedown", onDown);
      node.removeEventListener("touchstart", taking);
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("scroll", onScroll);
      onUp();
    };
  }, [view, hasNodes]);

  const stopFollowing = (): void => {
    view.follow = false;
    saveGraphFollow(false);
    if (view.mode === "fit") {
      view.mode = "manual";
      saveGraphMode(view.mode);
    }
  };
  const zoomBy = (factor: number): void => {
    stopFollowing();
    view.mode = "manual";
    view.scale = clampScale(view.scale * factor);
    saveGraphMode(view.mode);
    recordZoom(view.scale);
    redraw();
  };
  const fit = (): void => {
    stopFollowing();
    placeFit();
    saveGraphMode(view.mode);
  };
  const original = (): void => {
    stopFollowing();
    view.mode = "original";
    view.scale = 1;
    saveGraphMode(view.mode);
    redraw();
    if (viewport.current !== null) {
      viewport.current.scrollLeft = 0;
      viewport.current.scrollTop = 0;
    }
  };
  const follow = (): void => {
    view.follow = true;
    saveGraphFollow(true);
    view.focused = null;
    applyFollow(false);
    redraw();
  };

  if (run.nodes.length === 0) {
    return (
      <div className="graph-shell">
        <div className="graph graph-empty">
          <div className="empty">No nodes yet. Add some with dispatch.sh node add.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="graph-shell">
      <div className="graph-toolbar" role="toolbar" aria-label="Graph zoom">
        <button
          className={`btn graph-tool graph-follow${view.follow ? " is-on" : ""}`}
          type="button"
          aria-pressed={view.follow}
          title="Follow what is running: scrolls the graph to the node that is running now, or the next one to start"
          aria-label="Follow what is running: scrolls the graph to the node that is running now, or the next one to start"
          onClick={follow}
        >
          Follow live
        </button>
        <button className="btn graph-tool" type="button" title="Zoom in" aria-label="Zoom in" onClick={() => zoomBy(ZOOM_STEP)}>
          +
        </button>
        <button className="btn graph-tool" type="button" title="Zoom out" aria-label="Zoom out" onClick={() => zoomBy(1 / ZOOM_STEP)}>
          −
        </button>
        <button className="btn graph-tool" type="button" title="Fit graph to screen" aria-label="Fit graph to screen" onClick={fit}>
          Fit
        </button>
        <button className="btn graph-tool" type="button" title="Original size (100%)" aria-label="Original size (100%)" onClick={original}>
          100%
        </button>
        <button
          className={`btn graph-tool${view.hideDone ? " is-on" : ""}`}
          type="button"
          aria-pressed={view.hideDone}
          title="Hide the nodes that are done or skipped"
          aria-label="Hide done nodes"
          onClick={() => {
            view.hideDone = !view.hideDone;
            saveGraphHideDone(view.hideDone);
            redraw();
          }}
        >
          {view.hideDone ? `Show done (${hiddenCount})` : "Hide done"}
        </button>
        <span className="graph-zoom-label mono">{`${Math.round(view.scale * 100)}%`}</span>
        <span className="graph-hint muted">{hintText(target === null ? null : target.reason)}</span>
      </div>
      <div className="graph" ref={viewport} tabIndex={0} aria-label="Task graph viewport">
        <div className="graph-scaler" style={{ width: `${w * view.scale}px`, height: `${h * view.scale}px` }}>
          <div className="graph-inner" style={{ width: `${w}px`, height: `${h}px`, transform: `scale(${view.scale})` }}>
            <GraphSvg run={shown} layout={layout} selectedId={selectedId} onSelect={onSelect} harnessByProfile={harnessByProfile} maxAttempts={maxAttempts} />
          </div>
        </div>
      </div>
    </div>
  );
}
