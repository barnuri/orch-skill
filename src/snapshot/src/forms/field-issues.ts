import type { Issue } from "../../../shared/types/issue";

export type EnvParse = { env: Record<string, string>; issues: Issue[] };

const LINE_BREAK = /\r?\n/;
const INDEX_SEGMENT = /\[\d+\]/g;
const ENV_SEPARATOR: string = "=";
const ENV_LINE_REASON: string = "each line must be KEY=VALUE";
const DEFAULT_ENV_PATH: string = "env";

// Pure helpers behind the one-per-line textareas (flags, env, auth) and the per-field issue
// placement. No DOM here — field-dom.ts owns the elements; this file is unit-tested on its own.

// Textarea value → non-empty trimmed lines. Blank lines are noise, not entries.
export function linesOf(text: string): string[] {
  return text
    .split(LINE_BREAK)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

// `KEY=VALUE` lines → object; the first `=` splits, so values may themselves contain `=`.
// Lines without one are reported at `path` (the textarea's data-path) so attachFieldIssues can
// pin them to the control. Later duplicates win, matching what JSON.parse would do on disk.
export function envLinesToObject(text: string, path: string = DEFAULT_ENV_PATH): EnvParse {
  const env: Record<string, string> = {};
  const issues: Issue[] = [];
  for (const line of linesOf(text)) {
    const at = line.indexOf(ENV_SEPARATOR);
    if (at < 0) {
      issues.push({ path, reason: ENV_LINE_REASON });
      continue;
    }
    env[line.slice(0, at).trim()] = line.slice(at + 1);
  }
  return { env, issues };
}

// Inverse of envLinesToObject for populating the textarea; keeps the on-disk key order.
export function objectToEnvLines(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}${ENV_SEPARATOR}${value}`)
    .join("\n");
}

// `candidate` names `full` itself or an ancestor of it: `profiles.a.env` covers
// `profiles.a.env.FOO` and `profiles.a.flags` covers `profiles.a.flags[2]`, but `profiles.a`
// does not cover `profiles.ab`.
function coversPath(candidate: string, full: string): boolean {
  if (candidate === full) {
    return true;
  }
  if (!full.startsWith(candidate)) {
    return false;
  }
  const next = full.charAt(candidate.length);
  return next === "." || next === "[";
}

// Which field (by data-path) should show an issue: the longest path that covers the issue's
// path, tried both as reported and with `[n]` segments stripped so a form may label its controls
// either `memory[3].outcome` or `memory.outcome`. Null → the issue belongs in the top list.
export function longestPathMatch(paths: readonly string[], issuePath: string): string | null {
  const stripped = issuePath.replace(INDEX_SEGMENT, "");
  let best: string | null = null;
  for (const path of paths) {
    if (!coversPath(path, issuePath) && !coversPath(path, stripped)) {
      continue;
    }
    if (best === null || path.length > best.length) {
      best = path;
    }
  }
  return best;
}

// Drafts are edited in place, so the loaded document must never share structure with them.
export function deepCopy<T>(value: T): T {
  return structuredClone(value);
}
