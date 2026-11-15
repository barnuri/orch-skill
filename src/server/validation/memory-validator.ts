import type { Issue } from "../../shared/types/issue";
import { MAX_MEMORY_ENTRIES, MEMORY_KEYS, MEMORY_REQUIRED, TS } from "./rules";
import { isPlainObject } from "./plain-object";

const ROOT_PATH: string = "$";

type MemoryKey = (typeof MEMORY_KEYS)[number];

function isMemoryKey(key: string): key is MemoryKey {
  return (MEMORY_KEYS as readonly string[]).includes(key);
}

function entryPath(index: number): string {
  return `memory[${index}]`;
}

function fieldPath(index: number, key: string): string {
  return `${entryPath(index)}.${key}`;
}

/**
 * Field-specific rules for a value that is already known to be a string.
 * Notes may hold newlines, so there is deliberately no control-character rule.
 */
function stringFieldIssue(
  index: number,
  key: MemoryKey,
  value: string,
  outcomes: readonly string[],
): Issue | null {
  const path = fieldPath(index, key);
  if (key === "ts" && !TS.test(value)) {
    return { path, reason: "must be a UTC timestamp like 2026-01-31T12:00:00Z" };
  }
  if (key === "profile" && value.length === 0) {
    return { path, reason: "must not be empty" };
  }
  if (key === "outcome" && !outcomes.includes(value)) {
    return { path, reason: `must be one of ${outcomes.join(", ")}` };
  }
  return null;
}

function entryIssues(entry: unknown, index: number, outcomes: readonly string[]): Issue[] {
  if (!isPlainObject(entry)) {
    return [{ path: entryPath(index), reason: "must be an object" }];
  }
  const issues: Issue[] = [];
  for (const key of MEMORY_REQUIRED) {
    if (!(key in entry)) {
      issues.push({ path: fieldPath(index, key), reason: "required" });
    }
  }
  for (const [key, value] of Object.entries(entry)) {
    if (!isMemoryKey(key)) {
      issues.push({ path: fieldPath(index, key), reason: "unknown key" });
      continue;
    }
    if (typeof value !== "string") {
      issues.push({ path: fieldPath(index, key), reason: "must be a string" });
      continue;
    }
    const issue = stringFieldIssue(index, key, value, outcomes);
    if (issue !== null) {
      issues.push(issue);
    }
  }
  return issues;
}

/**
 * Validates a parsed memory.json document (a bare array of entries) and collects
 * every issue with its dotted path, so the dashboard can attach them to fields.
 * `outcomes` is the enum handed over from `lib/config.sh` via argv.
 */
export function memoryIssues(document: unknown, outcomes: readonly string[]): Issue[] {
  if (!Array.isArray(document)) {
    return [{ path: ROOT_PATH, reason: "must be an array" }];
  }
  const issues: Issue[] = [];
  if (document.length > MAX_MEMORY_ENTRIES) {
    issues.push({ path: ROOT_PATH, reason: `at most ${MAX_MEMORY_ENTRIES} entries` });
  }
  document.forEach((entry: unknown, index: number) => {
    issues.push(...entryIssues(entry, index, outcomes));
  });
  return issues;
}
