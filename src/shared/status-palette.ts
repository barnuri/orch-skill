/**
 * The one status palette of the orch UI: graph cards, run table rows, chips, node panel and the
 * snapshot renderer all colour a status through this table. Colour is never the only cue: every
 * surface prints the status word as visible text, and that text is the accessible name.
 *
 * The CSS side lives in src/snapshot/components.css (`.status-<key>`, `.chip.status-<key>`) and reads
 * the `--status-<key>` tokens of src/snapshot/tokens.css. This file must stay Bun-free: the snapshot
 * bundle imports it too.
 */
export const STATUS_PALETTE = {
  covered: { label: "Covered", tone: "purple" },
  skipped: { label: "Skipped", tone: "gray" },
  partial: { label: "Partial", tone: "amber" },
  full: { label: "Full", tone: "green" },
  done: { label: "Done", tone: "green" },
  blocked: { label: "Blocked", tone: "red" },
  error: { label: "Error", tone: "red" },
  waiting: { label: "Waiting", tone: "blue-gray" },
  "blocked-user": { label: "Blocked by user", tone: "amber" },
} as const;

export type StatusKey = keyof typeof STATUS_PALETTE;
export type StatusTone = (typeof STATUS_PALETTE)[StatusKey]["tone"];

export const STATUS_KEYS: readonly StatusKey[] = Object.keys(STATUS_PALETTE) as StatusKey[];

/** The palette key of a status word, or null when the word is not in the palette (running, stale, ...). `full`, `partial` and `blocked` are the result verdicts in the palette too; `unknown` is not. */
export function statusKeyOf(word: string): StatusKey | null {
  return Object.hasOwn(STATUS_PALETTE, word) ? (word as StatusKey) : null;
}

/** The class a surface adds next to its own classes, e.g. `status-partial`; empty when the word is not in the palette. */
export function paletteClass(word: string): string {
  const key = statusKeyOf(word);
  return key === null ? "" : `status-${key}`;
}
