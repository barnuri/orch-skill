/** One `run verify` failure, parsed from the CLI text. */
export interface VerifyFailure {
  nodes: string[];
  msg: string;
  hint: string;
}

/** Parses `verify FAILED` output: `N. [a,b] message` then `   fix: hint`. Anything else is ignored. */
export function parseVerifyOutput(text: string): VerifyFailure[] {
  const out: VerifyFailure[] = [];
  for (const line of text.split("\n")) {
    const head = /^\d+\. \[([^\]]*)\] (.*)$/.exec(line);
    if (head) {
      const label = head[1] ?? "";
      out.push({ nodes: label === "run" || label === "" ? [] : label.split(","), msg: head[2] ?? "", hint: "" });
      continue;
    }
    const fix = /^\s+fix: (.*)$/.exec(line);
    const last = out[out.length - 1];
    if (fix && last) {
      last.hint = fix[1] ?? "";
    }
  }
  return out;
}
