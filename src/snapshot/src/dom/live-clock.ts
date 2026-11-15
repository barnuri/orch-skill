import { fmtDur, rel } from "./format";

const LIVE_ATTR = "data-live-since";
const AGO_ATTR = "data-live-ago";
const AGO_PREFIX_ATTR = "data-live-ago-prefix";
const TICK_MS = 1000;
let timer: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  for (const node of document.querySelectorAll(`[${LIVE_ATTR}]`)) {
    const since = node.getAttribute(LIVE_ATTR);
    if (since !== null) {
      node.textContent = fmtDur(since);
    }
  }
  for (const node of document.querySelectorAll(`[${AGO_ATTR}]`)) {
    const at = node.getAttribute(AGO_ATTR);
    if (at !== null) {
      node.textContent = `${node.getAttribute(AGO_PREFIX_ATTR) ?? ""}${rel(at)}`;
    }
  }
}

function ensureTimer(): void {
  if (timer === null) {
    timer = setInterval(tick, TICK_MS);
  }
}

/** Marks an element whose text is "<prefix><n>m ago" since `iso`; the shared ticker keeps it current. */
export function markAgo(node: Element, iso: string, prefix: string = ""): void {
  node.setAttribute(AGO_ATTR, iso);
  node.setAttribute(AGO_PREFIX_ATTR, prefix);
  node.textContent = `${prefix}${rel(iso)}`;
  ensureTimer();
}

/**
 * Marks an element whose text is an elapsed time since `iso`, and starts the one shared 1 s
 * ticker. The ticker reads the DOM, so a re-rendered view needs no cleanup.
 */
export function markLive(node: Element, iso: string): void {
  node.setAttribute(LIVE_ATTR, iso);
  if (timer === null) {
    timer = setInterval(tick, TICK_MS);
  }
}
