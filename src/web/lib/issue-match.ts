import type { Issue } from "../../shared/types/issue";
import { longestPathMatch } from "./field-issues";

export interface MatchedIssues {
  /** Message lines per field path, ready to show under the control. */
  byPath: ReadonlyMap<string, readonly string[]>;
  /** Issues no control claims: the caller lists them at the top of the form. */
  unmatched: readonly Issue[];
}

// What the message says under the control: the part of the issue path below the field (`FOO`
// for an env key, `[2]` for a flag line) so a one-per-line textarea tells the user which line.
export function reasonFor(issue: Issue, fieldPath: string): string {
  const rest = issue.path.startsWith(fieldPath) ? issue.path.slice(fieldPath.length) : "";
  const sub = rest.startsWith(".") ? rest.slice(1) : rest;
  return sub === "" ? issue.reason : `${sub}: ${issue.reason}`;
}

/** Pins each issue to the field whose path covers it (see longestPathMatch). */
export function matchIssues(paths: readonly string[], issues: readonly Issue[]): MatchedIssues {
  const byPath = new Map<string, string[]>();
  const unmatched: Issue[] = [];
  for (const issue of issues) {
    const fieldPath = longestPathMatch(paths, issue.path);
    if (fieldPath === null) {
      unmatched.push(issue);
      continue;
    }
    byPath.set(fieldPath, [...(byPath.get(fieldPath) ?? []), reasonFor(issue, fieldPath)]);
  }
  return { byPath, unmatched };
}
