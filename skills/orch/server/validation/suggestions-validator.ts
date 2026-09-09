import type { Issue } from "../../shared/types/issue";
import {
  CONFIDENCE_VALUES,
  CONTROL_CHARS,
  MAX_DESCRIPTION_LEN,
  MAX_SUGGESTIONS,
  SUGGESTION_ACTION_KEYS,
  SUGGESTION_KEYS,
  SUGGESTION_ROOT_KEYS,
  SUGGESTION_STATUSES,
  TS,
} from "./rules";
import { isPlainObject } from "./plain-object";

const ROOT_PATH: string = "$";
const MUST_BE_OBJECT: string = "must be an object";
const MUST_BE_STRING: string = "must be a string";
const MUST_BE_ARRAY: string = "must be an array";
const UNKNOWN_KEY: string = "unknown key";
const REQUIRED: string = "required";

function unknownKeyIssues(
  object: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
): Issue[] {
  return Object.keys(object)
    .filter((key) => !allowed.includes(key))
    .map((key) => ({ path: prefix === "" ? key : `${prefix}.${key}`, reason: UNKNOWN_KEY }));
}

function textIssues(path: string, value: unknown, maxLength: number): Issue[] {
  if (typeof value !== "string") {
    return [{ path, reason: MUST_BE_STRING }];
  }
  const issues: Issue[] = [];
  if (value.length > maxLength) {
    issues.push({ path, reason: `at most ${maxLength} characters` });
  }
  if (CONTROL_CHARS.test(value)) {
    issues.push({ path, reason: "must not contain control characters" });
  }
  return issues;
}

function suggestionIssues(entry: unknown, index: number): Issue[] {
  const base = `suggestions[${index}]`;
  if (!isPlainObject(entry)) {
    return [{ path: base, reason: MUST_BE_OBJECT }];
  }
  const issues = unknownKeyIssues(entry, SUGGESTION_KEYS, base);
  for (const key of SUGGESTION_KEYS) {
    if (!(key in entry)) {
      issues.push({ path: `${base}.${key}`, reason: REQUIRED });
    }
  }
  if ("status" in entry) {
    const status = entry["status"];
    if (typeof status !== "string" || !SUGGESTION_STATUSES.includes(status as (typeof SUGGESTION_STATUSES)[number])) {
      issues.push({ path: `${base}.status`, reason: `must be one of ${SUGGESTION_STATUSES.join(", ")}` });
    }
  }
  if ("created" in entry) {
    const created = entry["created"];
    if (typeof created !== "string" || !TS.test(created)) {
      issues.push({ path: `${base}.created`, reason: "must be a UTC timestamp like 2026-01-31T12:00:00Z" });
    }
  }
  if ("confidence" in entry) {
    const confidence = entry["confidence"];
    if (typeof confidence !== "string" || !CONFIDENCE_VALUES.includes(confidence as (typeof CONFIDENCE_VALUES)[number])) {
      issues.push({ path: `${base}.confidence`, reason: `must be one of ${CONFIDENCE_VALUES.join(", ")}` });
    }
  }
  for (const key of ["title", "reason", "kind", "id", "fingerprint"] as const) {
    if (key in entry) {
      issues.push(...textIssues(`${base}.${key}`, entry[key], MAX_DESCRIPTION_LEN));
    }
  }
  if ("evidence" in entry) {
    const evidence = entry["evidence"];
    if (!Array.isArray(evidence)) {
      issues.push({ path: `${base}.evidence`, reason: MUST_BE_ARRAY });
    }
  }
  if ("action" in entry) {
    const action = entry["action"];
    if (!isPlainObject(action)) {
      issues.push({ path: `${base}.action`, reason: MUST_BE_OBJECT });
    } else {
      issues.push(...unknownKeyIssues(action, SUGGESTION_ACTION_KEYS, `${base}.action`));
      if (!("type" in action)) {
        issues.push({ path: `${base}.action.type`, reason: REQUIRED });
      }
    }
  }
  return issues;
}

export function suggestionsIssues(document: unknown): Issue[] {
  if (!isPlainObject(document)) {
    return [{ path: ROOT_PATH, reason: MUST_BE_OBJECT }];
  }
  const issues = unknownKeyIssues(document, SUGGESTION_ROOT_KEYS, "");
  for (const key of SUGGESTION_ROOT_KEYS) {
    if (!(key in document)) {
      issues.push({ path: key, reason: REQUIRED });
    }
  }
  if ("generated_at" in document) {
    const generated = document["generated_at"];
    if (typeof generated !== "string" || !TS.test(generated)) {
      issues.push({ path: "generated_at", reason: "must be a UTC timestamp like 2026-01-31T12:00:00Z" });
    }
  }
  if ("suggestions" in document) {
    const suggestions = document["suggestions"];
    if (!Array.isArray(suggestions)) {
      issues.push({ path: "suggestions", reason: MUST_BE_ARRAY });
    } else {
      if (suggestions.length > MAX_SUGGESTIONS) {
        issues.push({ path: "suggestions", reason: `at most ${MAX_SUGGESTIONS} suggestions` });
      }
      suggestions.forEach((entry: unknown, index: number) => {
        issues.push(...suggestionIssues(entry, index));
      });
    }
  }
  return issues;
}
