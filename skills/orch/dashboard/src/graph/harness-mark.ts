import { svgEl } from "../dom/el";

/**
 * One glyph per harness, so the same harness always reads the same way — on a graph node, a
 * harness card and a profile row alike.
 *
 * Where a vendor publishes a single-colour mark, that mark is used: the four below are the
 * official ones, vendored from simple-icons (the icon set is CC0; the trademarks remain their
 * owners'). Using a vendor's mark to identify that vendor's own product is what it is for.
 * They are inlined rather than fetched because the dashboard ships under a CSP with no external
 * resources, and the repo takes no dependencies.
 *
 * Harnesses without a published mark keep an authored geometric glyph. Those are stroked on a
 * 16-unit grid; the official marks are filled on a 24-unit grid — hence `box` and `filled`
 * per entry. Colour is not set here: each glyph gets a `mark-<id>` class and styles.css holds
 * the brand colour, so it can differ per theme (Cursor's mark is black, which is invisible on
 * the dark surface and correct on the light one).
 */

interface HarnessMark {
  /** Path `d` strings. Official marks are one path; authored glyphs may be several. */
  readonly paths: readonly string[];
  /** Extra primitives an authored glyph needs beyond paths. */
  readonly circles?: readonly { readonly cx: number; readonly cy: number; readonly r: number }[];
  readonly rects?: readonly {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly rx: number;
  }[];
  /** Grid the geometry was drawn on. */
  readonly box: number;
  /** Official marks are solid; authored glyphs are stroked. */
  readonly filled: boolean;
}

const OFFICIAL_BOX: number = 24;
const AUTHORED_BOX: number = 16;

const MARKS: Readonly<Record<string, HarnessMark>> = {
  // Official, from simple-icons.
  claude: { paths: ["m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"], box: OFFICIAL_BOX, filled: true },
  "cursor-agent": { paths: ["M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23"], box: OFFICIAL_BOX, filled: true },
  codex: { paths: ["M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"], box: OFFICIAL_BOX, filled: true },
  gemini: { paths: ["M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"], box: OFFICIAL_BOX, filled: true },

  // Authored: no published single-colour mark to use.
  opencode: { paths: ["M6 4 L2 8 L6 12", "M10 4 L14 8 L10 12"], box: AUTHORED_BOX, filled: false },
  "local-llm": {
    paths: ["M2 6 L4 6", "M2 10 L4 10", "M12 6 L14 6", "M12 10 L14 10"],
    rects: [{ x: 4, y: 4, width: 8, height: 8, rx: 1.5 }],
    box: AUTHORED_BOX,
    filled: false,
  },
  pi: { paths: ["M3 5 L13 5", "M6 5 L5 12", "M10 5 L11 12"], box: AUTHORED_BOX, filled: false },
  aider: {
    paths: [],
    circles: [
      { cx: 6, cy: 8, r: 4 },
      { cx: 10, cy: 8, r: 4 },
    ],
    box: AUTHORED_BOX,
    filled: false,
  },
};

const UNKNOWN_MARK: HarnessMark = {
  paths: [],
  circles: [{ cx: 8, cy: 8, r: 5 }],
  box: AUTHORED_BOX,
  filled: false,
};

export const HARNESS_MARK_IDS: readonly string[] = [
  "claude",
  "cursor-agent",
  "opencode",
  "local-llm",
  "pi",
  "codex",
  "aider",
  "gemini",
];

function markFor(id: string): HarnessMark {
  return MARKS[id] ?? UNKNOWN_MARK;
}

export interface HarnessMarkMeta {
  /** False when the id falls back to the generic ring. */
  readonly known: boolean;
  /** True for an official vendor mark, which is solid rather than stroked. */
  readonly official: boolean;
}

/** Exposed for the coverage tests — the glyph geometry itself needs a DOM to assert against. */
export function harnessMarkMeta(id: string): HarnessMarkMeta {
  const mark = MARKS[id];
  return { known: mark !== undefined, official: mark?.filled === true };
}

function shapesOf(mark: HarnessMark): SVGElement[] {
  const shapes: SVGElement[] = [];
  for (const d of mark.paths) {
    shapes.push(svgEl("path", { d }));
  }
  for (const rect of mark.rects ?? []) {
    shapes.push(
      svgEl("rect", {
        x: String(rect.x),
        y: String(rect.y),
        width: String(rect.width),
        height: String(rect.height),
        rx: String(rect.rx),
      }),
    );
  }
  for (const circle of mark.circles ?? []) {
    shapes.push(svgEl("circle", { cx: String(circle.cx), cy: String(circle.cy), r: String(circle.r) }));
  }
  return shapes;
}

/**
 * The glyph as an SVG `<g>`, scaled from its own grid to `size` and offset to (x, y). Usable
 * inside the graph's `<svg>` and, via `harnessMarkIcon`, in plain HTML.
 */
export function harnessMarkGroup(id: string, x: number, y: number, size: number): SVGElement {
  const mark = markFor(id);
  const known = MARKS[id] !== undefined;
  const scale = size / mark.box;
  const group = svgEl("g", {
    class: `harness-mark ${mark.filled ? "is-filled" : "is-stroked"} ${known ? `mark-${id}` : "mark-unknown"}`,
    transform: `translate(${x} ${y}) scale(${scale.toFixed(4)})`,
  });
  for (const shape of shapesOf(mark)) {
    group.appendChild(shape);
  }
  return group;
}

/** A standalone `<svg>` wrapper, for use in HTML (harness cards, profile rows). */
export function harnessMarkIcon(id: string, size: number = 16): SVGSVGElement {
  const mark = markFor(id);
  const svg = svgEl("svg", {
    class: "harness-mark-icon",
    width: String(size),
    height: String(size),
    viewBox: `0 0 ${mark.box} ${mark.box}`,
    role: "img",
    "aria-label": `${id} harness`,
  });
  svg.appendChild(harnessMarkGroup(id, 0, 0, mark.box));
  return svg;
}
