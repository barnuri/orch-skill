// CSI sequences (colours, cursor moves) and OSC sequences (titles, links) a harness prints.
const ANSI_PATTERN: RegExp = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Terminal escape codes removed, so a log reads as text instead of `[91m[1mError:`. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}
