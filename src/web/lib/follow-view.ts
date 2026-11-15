export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FollowInput {
  viewportW: number;
  viewportH: number;
  graphW: number;
  graphH: number;
  /** The scale that fits the whole graph on screen. */
  fitScale: number;
  /** The nodes to bring into view, in graph coordinates. The first is the primary one. */
  boxes: readonly Box[];
}

export interface FollowView {
  scale: number;
  /** Scroll offsets, in screen pixels at `scale`. */
  left: number;
  top: number;
  /** True when the whole graph is readable at once, so nothing needs to scroll. */
  fitsAll: boolean;
}

/** Below this, a fitted graph is too small to read, so following zooms in instead. */
export const READABLE_FIT = 0.7;
/** The scale used when following a part of a large graph. */
export const FOLLOW_SCALE = 0.9;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

function bounds(boxes: readonly Box[]): Box {
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * Where to look. A graph that fits at a readable size just stays fitted. A larger one is shown at a
 * readable scale and scrolled to the focus: centered on all the focused nodes when they fit on screen
 * together, otherwise on the primary one.
 */
export function followView(input: FollowInput): FollowView {
  if (input.fitScale >= READABLE_FIT || input.boxes.length === 0) {
    return { scale: input.fitScale, left: 0, top: 0, fitsAll: true };
  }
  const scale = FOLLOW_SCALE;
  const all = bounds(input.boxes);
  const together = all.w * scale <= input.viewportW && all.h * scale <= input.viewportH;
  const focus = together ? all : (input.boxes[0] as Box);
  const cx = (focus.x + focus.w / 2) * scale;
  const cy = (focus.y + focus.h / 2) * scale;
  const maxLeft = Math.max(0, input.graphW * scale - input.viewportW);
  const maxTop = Math.max(0, input.graphH * scale - input.viewportH);
  return {
    scale,
    left: clamp(cx - input.viewportW / 2, 0, maxLeft),
    top: clamp(cy - input.viewportH / 2, 0, maxTop),
    fitsAll: false,
  };
}
