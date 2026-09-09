import type { Issue } from "../../shared/types/issue";
import {
  CONTROL_CHARS,
  ENV_REF,
  FORBIDDEN_ENV_KEYS,
  FORBIDDEN_ENV_PREFIXES,
  IDENTIFIER,
  MAX_AUTH,
  MAX_ENV,
  MAX_ENV_VALUE_LEN,
  MAX_FLAG_LEN,
  MAX_FLAGS,
  MAX_MODEL_LEN,
  MAX_PROFILES,
  PERCENT_MAX,
  PROFILE_KEYS,
  PROFILE_NAME,
  RETENTION_MAX_DAYS,
  ROOT_KEYS,
  SECRET_KEY,
  SETTINGS_KEYS,
} from "./rules";
import { isPlainObject } from "./plain-object";

const ROOT_PATH: string = "$";
const REQUIRED: string = "required";
const UNKNOWN_KEY: string = "unknown key";
const MUST_BE_OBJECT: string = "must be an object";
const MUST_BE_STRING: string = "must be a string";
const MUST_BE_ARRAY: string = "must be an array";
const MUST_BE_IDENTIFIER: string = "must be an identifier";
const NO_CONTROL_CHARS: string = "must not contain control characters";
const FORBIDDEN_ENV_KEY: string =
  "forbidden — changes which code runs when the harness spawns";
const PARTIAL_ENV_REF: string = "a reference must be exactly ${NAME}";
const SECRET_LITERAL: string = "looks like a secret — use ${NAME}";
const ENV_REF_MARKER: string = "${";

function isIntegerInRange(value: unknown, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
}

function isForbiddenEnvKey(key: string): boolean {
  if ((FORBIDDEN_ENV_KEYS as readonly string[]).includes(key)) {
    return true;
  }
  return FORBIDDEN_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

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
    issues.push({ path, reason: NO_CONTROL_CHARS });
  }
  return issues;
}

function defaultProfileIssues(value: unknown, profiles: unknown): Issue[] {
  const path = "settings.default_profile";
  if (typeof value !== "string") {
    return [{ path, reason: MUST_BE_STRING }];
  }
  if (!isPlainObject(profiles)) {
    return [];
  }
  const profileNames = Object.keys(profiles);
  if (profileNames.length === 0) {
    return value === "" ? [] : [{ path, reason: "must be empty when there are no profiles" }];
  }
  return profileNames.includes(value) ? [] : [{ path, reason: "no such profile" }];
}

function settingsIssues(settings: unknown, profiles: unknown): Issue[] {
  if (!isPlainObject(settings)) {
    return [{ path: "settings", reason: MUST_BE_OBJECT }];
  }
  const issues = unknownKeyIssues(settings, SETTINGS_KEYS, "settings");
  if ("default_profile" in settings) {
    issues.push(...defaultProfileIssues(settings["default_profile"], profiles));
  }
  if ("retention_days" in settings && !isIntegerInRange(settings["retention_days"], RETENTION_MAX_DAYS)) {
    issues.push({
      path: "settings.retention_days",
      reason: `must be an integer 0-${RETENTION_MAX_DAYS}`,
    });
  }
  if ("budget_threshold" in settings && !isIntegerInRange(settings["budget_threshold"], PERCENT_MAX)) {
    issues.push({
      path: "settings.budget_threshold",
      reason: `must be an integer 0-${PERCENT_MAX}`,
    });
  }
  return issues;
}

function harnessIssues(path: string, spec: Record<string, unknown>, harnesses: readonly string[]): Issue[] {
  if (!("harness" in spec)) {
    return [{ path, reason: REQUIRED }];
  }
  const harness = spec["harness"];
  if (typeof harness === "string" && harnesses.includes(harness)) {
    return [];
  }
  return [{ path, reason: `must be one of ${harnesses.join(", ")}` }];
}

function flagsIssues(path: string, flags: unknown): Issue[] {
  if (!Array.isArray(flags)) {
    return [{ path, reason: MUST_BE_ARRAY }];
  }
  const issues: Issue[] = [];
  if (flags.length > MAX_FLAGS) {
    issues.push({ path, reason: `at most ${MAX_FLAGS} flags` });
  }
  flags.forEach((flag: unknown, index: number) => {
    const flagPath = `${path}[${index}]`;
    if (flag === "") {
      issues.push({ path: flagPath, reason: "must not be empty" });
      return;
    }
    issues.push(...textIssues(flagPath, flag, MAX_FLAG_LEN));
  });
  return issues;
}

function envValueIssues(path: string, key: string, value: unknown): Issue[] {
  const issues = textIssues(path, value, MAX_ENV_VALUE_LEN);
  if (typeof value !== "string") {
    return issues;
  }
  const isReference = ENV_REF.test(value);
  if (value.includes(ENV_REF_MARKER) && !isReference) {
    issues.push({ path, reason: PARTIAL_ENV_REF });
  }
  if (SECRET_KEY.test(key) && !isReference) {
    issues.push({ path, reason: SECRET_LITERAL });
  }
  return issues;
}

function envIssues(path: string, env: unknown): Issue[] {
  if (!isPlainObject(env)) {
    return [{ path, reason: MUST_BE_OBJECT }];
  }
  const issues: Issue[] = [];
  const keys = Object.keys(env);
  if (keys.length > MAX_ENV) {
    issues.push({ path, reason: `at most ${MAX_ENV} variables` });
  }
  for (const key of keys) {
    const keyPath = `${path}.${key}`;
    if (!IDENTIFIER.test(key)) {
      issues.push({ path: keyPath, reason: MUST_BE_IDENTIFIER });
    } else if (isForbiddenEnvKey(key)) {
      issues.push({ path: keyPath, reason: FORBIDDEN_ENV_KEY });
    }
    issues.push(...envValueIssues(keyPath, key, env[key]));
  }
  return issues;
}

function authIssues(path: string, auth: unknown): Issue[] {
  if (!Array.isArray(auth)) {
    return [{ path, reason: MUST_BE_ARRAY }];
  }
  const issues: Issue[] = [];
  if (auth.length > MAX_AUTH) {
    issues.push({ path, reason: `at most ${MAX_AUTH} entries` });
  }
  const seen = new Set<string>();
  auth.forEach((entry: unknown, index: number) => {
    const entryPath = `${path}[${index}]`;
    if (typeof entry !== "string" || !IDENTIFIER.test(entry)) {
      issues.push({ path: entryPath, reason: MUST_BE_IDENTIFIER });
      return;
    }
    if (seen.has(entry)) {
      issues.push({ path: entryPath, reason: "duplicate" });
    }
    seen.add(entry);
  });
  return issues;
}

function profileIssues(name: string, spec: unknown, harnesses: readonly string[]): Issue[] {
  const path = `profiles.${name}`;
  const issues: Issue[] = PROFILE_NAME.test(name) ? [] : [{ path, reason: "invalid name" }];
  if (!isPlainObject(spec)) {
    issues.push({ path, reason: MUST_BE_OBJECT });
    return issues;
  }
  issues.push(...unknownKeyIssues(spec, PROFILE_KEYS, path));
  issues.push(...harnessIssues(`${path}.harness`, spec, harnesses));
  if ("model" in spec) {
    issues.push(...textIssues(`${path}.model`, spec["model"], MAX_MODEL_LEN));
  }
  if ("flags" in spec) {
    issues.push(...flagsIssues(`${path}.flags`, spec["flags"]));
  }
  if ("env" in spec) {
    issues.push(...envIssues(`${path}.env`, spec["env"]));
  }
  if ("auth" in spec) {
    issues.push(...authIssues(`${path}.auth`, spec["auth"]));
  }
  return issues;
}

function profilesMapIssues(profiles: unknown, harnesses: readonly string[]): Issue[] {
  if (!isPlainObject(profiles)) {
    return [{ path: "profiles", reason: MUST_BE_OBJECT }];
  }
  const entries = Object.entries(profiles);
  const issues: Issue[] =
    entries.length > MAX_PROFILES ? [{ path: "profiles", reason: `at most ${MAX_PROFILES} profiles` }] : [];
  for (const [name, spec] of entries) {
    issues.push(...profileIssues(name, spec, harnesses));
  }
  return issues;
}

/**
 * Validates a parsed profiles.json against every rule, collecting ALL issues
 * with dotted paths (e.g. `profiles.claude-hub.env.KEY`) instead of stopping
 * at the first one, so the dashboard can attach each issue to its field.
 */
export function profilesIssues(document: unknown, harnesses: readonly string[]): Issue[] {
  if (!isPlainObject(document)) {
    return [{ path: ROOT_PATH, reason: MUST_BE_OBJECT }];
  }
  const issues = unknownKeyIssues(document, ROOT_KEYS, "");
  for (const key of ROOT_KEYS) {
    if (!(key in document)) {
      issues.push({ path: key, reason: REQUIRED });
    }
  }
  if ("settings" in document) {
    issues.push(...settingsIssues(document["settings"], document["profiles"]));
  }
  if ("profiles" in document) {
    issues.push(...profilesMapIssues(document["profiles"], harnesses));
  }
  return issues;
}
