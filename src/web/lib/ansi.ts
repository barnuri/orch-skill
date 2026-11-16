// CSI sequences (colours, cursor moves) and OSC sequences (titles, links) a harness prints.
const ANSI_PATTERN: RegExp = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Terminal escape codes removed, so a log reads as text instead of `[91m[1mError:`. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/** Foreground colour: a base index 0-15 (styled by the --status tokens) or a CSS colour for 256 and truecolor. */
export interface AnsiStyle {
  base: number | null;
  rgb: string | null;
  bold: boolean;
  dim: boolean;
}

export interface AnsiSegment {
  text: string;
  style: AnsiStyle;
}

const PLAIN: AnsiStyle = { base: null, rgb: null, bold: false, dim: false };
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];
// Matches an SGR (colour and style, captured) or any other escape (skipped).
const SEQUENCE: RegExp = /\x1b\[([0-9;]*)m|\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

function paletteRgb(n: number): string {
  if (n >= 16 && n < 232) {
    const i = n - 16;
    return `rgb(${CUBE_LEVELS[Math.floor(i / 36)]},${CUBE_LEVELS[Math.floor(i / 6) % 6]},${CUBE_LEVELS[i % 6]})`;
  }
  const gray = 8 + (n - 232) * 10;
  return `rgb(${gray},${gray},${gray})`;
}

// Applies one SGR parameter list (the digits between ESC[ and m) to the current style.
function applySgr(style: AnsiStyle, params: string): AnsiStyle {
  const codes = params === "" ? [0] : params.split(";").map((c) => Number(c || 0));
  let next = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i] ?? 0;
    if (c === 0) next = { ...PLAIN };
    else if (c === 1) next.bold = true;
    else if (c === 2) next.dim = true;
    else if (c === 22) next.bold = next.dim = false;
    else if (c >= 30 && c <= 37) next = { ...next, base: c - 30, rgb: null };
    else if (c >= 90 && c <= 97) next = { ...next, base: c - 90 + 8, rgb: null };
    else if (c === 39) next = { ...next, base: null, rgb: null };
    else if (c === 38 && codes[i + 1] === 5) {
      const n = codes[i + 2] ?? 0;
      next = n < 16 ? { ...next, base: n, rgb: null } : { ...next, base: null, rgb: paletteRgb(n) };
      i += 2;
    } else if (c === 38 && codes[i + 1] === 2) {
      const [r = 0, g = 0, b = 0] = codes.slice(i + 2, i + 5);
      next = { ...next, base: null, rgb: `rgb(${r},${g},${b})` };
      i += 4;
    }
    // Background colours (40-49, 48) are not shown: the log keeps its page background.
  }
  return next;
}

/**
 * Splits a log into text runs with their colour. Text is plain data: the caller renders it as
 * text nodes, so a log line that looks like HTML stays text. Carriage returns are dropped.
 */
export function ansiSegments(input: string): AnsiSegment[] {
  const text = input.replace(/\r/g, "");
  const segments: AnsiSegment[] = [];
  let style: AnsiStyle = PLAIN;
  let last = 0;
  const push = (end: number) => {
    if (end > last) segments.push({ text: text.slice(last, end), style });
  };
  for (const m of text.matchAll(SEQUENCE)) {
    const at = m.index ?? 0;
    push(at);
    if (m[1] !== undefined) style = applySgr(style, m[1]);
    last = at + m[0].length;
  }
  push(text.length);
  return segments;
}
