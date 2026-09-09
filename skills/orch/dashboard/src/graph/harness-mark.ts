import { svgEl } from "../dom/el";

/**
 * One authored glyph per harness, so the same harness always reads the same way — on a graph
 * node, a harness card and a profile row alike.
 *
 * These are deliberately NOT reproductions of the vendors' brand logos: the dashboard ships
 * under a CSP with no external resources and the repo takes no dependencies, so a real logo
 * would have to be vendored, and redistributing a trademarked mark is not ours to do. Each
 * glyph is a distinct geometric shape drawn on a 16×16 grid, recognisable at node size.
 *
 * Every shape is stroked with `currentColor` (no fills except where noted) so it inherits the
 * node's profile accent in the graph and the text colour everywhere else.
 */
export const HARNESS_MARK_IDS = [
  "claude",
  "cursor-agent",
  "opencode",
  "local-llm",
  "pi",
  "codex",
  "aider",
  "gemini",
] as const;

export type HarnessMarkId = (typeof HARNESS_MARK_IDS)[number];

const BOX: number = 16;

function isKnown(id: string): id is HarnessMarkId {
  return (HARNESS_MARK_IDS as readonly string[]).includes(id);
}

function line(x1: number, y1: number, x2: number, y2: number): SVGElement {
  return svgEl("line", { x1: String(x1), y1: String(y1), x2: String(x2), y2: String(y2) });
}

function path(d: string): SVGElement {
  return svgEl("path", { d });
}

function circle(cx: number, cy: number, r: number, filled: boolean = false): SVGElement {
  return svgEl("circle", {
    cx: String(cx),
    cy: String(cy),
    r: String(r),
    ...(filled ? { class: "filled" } : {}),
  });
}

/** An eight-spoke asterisk. */
function claudeMark(): SVGElement[] {
  const shapes: SVGElement[] = [];
  const r = 6;
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI / 4) * i;
    shapes.push(line(8, 8, 8 + Math.cos(a) * r, 8 + Math.sin(a) * r));
  }
  return shapes;
}

/** A pointer arrow. One closed outline — the I-beam-plus-arrow pair read as two marks at 15px. */
function cursorMark(): SVGElement[] {
  return [path("M3.5 2.5 L12.5 8.2 L8.4 9.1 L10.2 13.4 L7.9 14.2 L6.2 9.9 L3.5 12.4 Z")];
}

/** Angle brackets. */
function opencodeMark(): SVGElement[] {
  return [path("M6 4 L2 8 L6 12"), path("M10 4 L14 8 L10 12")];
}

/** A chip: square die with pins on both sides. */
function localLlmMark(): SVGElement[] {
  return [
    svgEl("rect", { x: "4", y: "4", width: "8", height: "8", rx: "1.5" }),
    line(2, 6, 4, 6),
    line(2, 10, 4, 10),
    line(12, 6, 14, 6),
    line(12, 10, 14, 10),
  ];
}

/** The pi form: bar over two legs. */
function piMark(): SVGElement[] {
  return [path("M3 5 L13 5"), path("M6 5 L5 12"), path("M10 5 L11 12")];
}

/** A hexagon. */
function codexMark(): SVGElement[] {
  return [path("M8 2 L13.2 5 L13.2 11 L8 14 L2.8 11 L2.8 5 Z")];
}

/** Two overlapping circles — a pair. */
function aiderMark(): SVGElement[] {
  return [circle(6, 8, 4), circle(10, 8, 4)];
}

/** A four-point sparkle. */
function geminiMark(): SVGElement[] {
  return [path("M8 1.5 C9 6 10 7 14.5 8 C10 9 9 10 8 14.5 C7 10 6 9 1.5 8 C6 7 7 6 8 1.5 Z")];
}

/** Fallback for a harness with no glyph yet: a ringed dot. */
function unknownMark(): SVGElement[] {
  return [circle(8, 8, 5), circle(8, 8, 1.6, true)];
}

function shapesFor(id: string): SVGElement[] {
  switch (id) {
    case "claude":
      return claudeMark();
    case "cursor-agent":
      return cursorMark();
    case "opencode":
      return opencodeMark();
    case "local-llm":
      return localLlmMark();
    case "pi":
      return piMark();
    case "codex":
      return codexMark();
    case "aider":
      return aiderMark();
    case "gemini":
      return geminiMark();
    default:
      return unknownMark();
  }
}

/**
 * The glyph as an SVG `<g>`, scaled from its 16×16 grid to `size` and offset to (x, y).
 * Usable inside the graph's `<svg>` and, wrapped by `harnessMarkIcon`, in plain HTML.
 */
export function harnessMarkGroup(id: string, x: number, y: number, size: number): SVGElement {
  const scale = size / BOX;
  const group = svgEl("g", {
    class: isKnown(id) ? `harness-mark mark-${id}` : "harness-mark mark-unknown",
    transform: `translate(${x} ${y}) scale(${scale})`,
  });
  for (const shape of shapesFor(id)) {
    group.appendChild(shape);
  }
  return group;
}

/** A standalone `<svg>` wrapper, for use in HTML (harness cards, profile rows). */
export function harnessMarkIcon(id: string, size: number = 16): SVGSVGElement {
  const svg = svgEl("svg", {
    class: "harness-mark-icon",
    width: String(size),
    height: String(size),
    viewBox: `0 0 ${BOX} ${BOX}`,
    role: "img",
    "aria-label": `${id} harness`,
  });
  svg.appendChild(harnessMarkGroup(id, 0, 0, BOX));
  return svg;
}
