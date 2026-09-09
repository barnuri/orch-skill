import type { Issue } from "../../shared/types/issue";
import {
  isValidAllowedModelEntry,
  modelAllowEntryMatches,
} from "../../shared/types/model-pattern";
import {
  COMPLEXITY_VALUES,
  CONFIDENCE_VALUES,
  CONTROL_CHARS,
  COST_VALUES,
  ENV_REF,
  FORBIDDEN_ENV_KEYS,
  FORBIDDEN_ENV_PREFIXES,
  IDENTIFIER,
  LEARNING_DAYS_MAX,
  LEARNING_KEYS,
  LEARNING_SAMPLES_MAX,
  MAX_AUTH,
  MAX_DESCRIPTION_LEN,
  MAX_ENV,
  MAX_ENV_VALUE_LEN,
  MAX_EXAMPLE_LEN,
  MAX_EXAMPLE_TASKS,
  MAX_FLAG_LEN,
  MAX_FLAGS,
  MAX_MODEL_LEN,
  MAX_MODELS,
  MAX_PRIORITY,
  MAX_PROFILES,
  MAX_TAG_LEN,
  MAX_TAGS,
  MIN_PRIORITY,
  MODEL_ID,
  MODEL_KEYS,
  PERCENT_MAX,
  PROFILE_KEYS,
  PROFILE_NAME,
  QUALITY_VALUES,
  RETENTION_MAX_DAYS,
  RISK_VALUES,
  ROOT_KEYS,
  SECRET_KEY,
  SETTINGS_KEYS,
  SPEED_VALUES,
} from "./rules";
import { isPlainObject } from "./plain-object";

const ROOT_PATH: string = "$";
const REQUIRED: string = "required";
const UNKNOWN_KEY: string = "unknown key";
const MUST_BE_OBJECT: string = "must be an object";
const MUST_BE_STRING: string = "must be a string";
const MUST_BE_ARRAY: string = "must be an array";
const MUST_BE_BOOLEAN: string = "must be a boolean";
const MUST_BE_IDENTIFIER: string = "must be an identifier";
const NO_CONTROL_CHARS: string = "must not contain control characters";
const FORBIDDEN_ENV_KEY: string =
  "forbidden — changes which code runs when the harness spawns";
const PARTIAL_ENV_REF: string = "a reference must be exactly ${NAME}";
const SECRET_LITERAL: string = "looks like a secret — use ${NAME}";
const ENV_REF_MARKER: string = "${";

function isIntegerInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
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

function enumIssues(path: string, value: unknown, allowed: readonly string[]): Issue[] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    return [{ path, reason: `must be one of ${allowed.join(", ")}` }];
  }
  return [];
}

function stringArrayIssues(path: string, value: unknown, maxItems: number, maxLen: number): Issue[] {
  if (!Array.isArray(value)) {
    return [{ path, reason: MUST_BE_ARRAY }];
  }
  const issues: Issue[] = [];
  if (value.length > maxItems) {
    issues.push({ path, reason: `at most ${maxItems} entries` });
  }
  value.forEach((entry: unknown, index: number) => {
    issues.push(...textIssues(`${path}[${index}]`, entry, maxLen));
  });
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

function learningIssues(learning: unknown): Issue[] {
  if (!isPlainObject(learning)) {
    return [{ path: "settings.learning", reason: MUST_BE_OBJECT }];
  }
  const issues = unknownKeyIssues(learning, LEARNING_KEYS, "settings.learning");
  if ("min_samples" in learning && !isIntegerInRange(learning["min_samples"], 1, LEARNING_SAMPLES_MAX)) {
    issues.push({
      path: "settings.learning.min_samples",
      reason: `must be an integer 1-${LEARNING_SAMPLES_MAX}`,
    });
  }
  for (const key of ["recency_days", "dismiss_ttl_days"] as const) {
    if (key in learning && !isIntegerInRange(learning[key], 1, LEARNING_DAYS_MAX)) {
      issues.push({
        path: `settings.learning.${key}`,
        reason: `must be an integer 1-${LEARNING_DAYS_MAX}`,
      });
    }
  }
  for (const key of ["auto_record_memory", "auto_scan_on_finish", "auto_apply_safe"] as const) {
    if (key in learning && typeof learning[key] !== "boolean") {
      issues.push({ path: `settings.learning.${key}`, reason: MUST_BE_BOOLEAN });
    }
  }
  return issues;
}

function settingsIssues(settings: unknown, profiles: unknown, harnesses: readonly string[]): Issue[] {
  if (!isPlainObject(settings)) {
    return [{ path: "settings", reason: MUST_BE_OBJECT }];
  }
  const issues = unknownKeyIssues(settings, SETTINGS_KEYS, "settings");
  if ("default_profile" in settings) {
    issues.push(...defaultProfileIssues(settings["default_profile"], profiles));
  }
  if ("retention_days" in settings && !isIntegerInRange(settings["retention_days"], 0, RETENTION_MAX_DAYS)) {
    issues.push({
      path: "settings.retention_days",
      reason: `must be an integer 0-${RETENTION_MAX_DAYS}`,
    });
  }
  if ("budget_threshold" in settings && !isIntegerInRange(settings["budget_threshold"], 0, PERCENT_MAX)) {
    issues.push({
      path: "settings.budget_threshold",
      reason: `must be an integer 0-${PERCENT_MAX}`,
    });
  }
  if ("learning" in settings) {
    issues.push(...learningIssues(settings["learning"]));
  }
  if ("disabled_harnesses" in settings) {
    issues.push(...stringArrayIssues("settings.disabled_harnesses", settings["disabled_harnesses"], MAX_PROFILES, MAX_MODEL_LEN));
    const list = settings["disabled_harnesses"];
    if (Array.isArray(list)) {
      list.forEach((entry: unknown, index: number) => {
        if (typeof entry === "string" && !harnesses.includes(entry)) {
          issues.push({
            path: `settings.disabled_harnesses[${index}]`,
            reason: `must be one of ${harnesses.join(", ")}`,
          });
        }
      });
    }
  }
  return issues;
}

function modelIdIssues(name: string): Issue[] {
  const path = `models.${name}`;
  return MODEL_ID.test(name) ? [] : [{ path, reason: "invalid id" }];
}

function modelIssues(name: string, spec: unknown, harnesses: readonly string[]): Issue[] {
  const path = `models.${name}`;
  const issues = modelIdIssues(name);
  if (!isPlainObject(spec)) {
    issues.push({ path, reason: MUST_BE_OBJECT });
    return issues;
  }
  issues.push(...unknownKeyIssues(spec, MODEL_KEYS, path));
  if (!("slug" in spec)) {
    issues.push({ path: `${path}.slug`, reason: REQUIRED });
  } else {
    issues.push(...textIssues(`${path}.slug`, spec["slug"], MAX_MODEL_LEN));
  }
  if (!("harnesses" in spec)) {
    issues.push({ path: `${path}.harnesses`, reason: REQUIRED });
  } else {
    const harnessList = spec["harnesses"];
    if (!Array.isArray(harnessList) || harnessList.length === 0) {
      issues.push({ path: `${path}.harnesses`, reason: "must be a non-empty array" });
    } else {
      harnessList.forEach((h: unknown, index: number) => {
        if (typeof h !== "string" || !harnesses.includes(h)) {
          issues.push({
            path: `${path}.harnesses[${index}]`,
            reason: `must be one of ${harnesses.join(", ")}`,
          });
        }
      });
    }
  }
  if ("description" in spec) {
    issues.push(...textIssues(`${path}.description`, spec["description"], MAX_DESCRIPTION_LEN));
  }
  if ("cost" in spec) {
    issues.push(...enumIssues(`${path}.cost`, spec["cost"], COST_VALUES));
  }
  if ("quality" in spec) {
    issues.push(...enumIssues(`${path}.quality`, spec["quality"], QUALITY_VALUES));
  }
  if ("speed" in spec) {
    issues.push(...enumIssues(`${path}.speed`, spec["speed"], SPEED_VALUES));
  }
  if ("max_complexity" in spec) {
    issues.push(...enumIssues(`${path}.max_complexity`, spec["max_complexity"], COMPLEXITY_VALUES));
  }
  if ("tags" in spec) {
    issues.push(...stringArrayIssues(`${path}.tags`, spec["tags"], MAX_TAGS, MAX_TAG_LEN));
  }
  return issues;
}

function modelsMapIssues(models: unknown, harnesses: readonly string[]): Issue[] {
  if (!isPlainObject(models)) {
    return [{ path: "models", reason: MUST_BE_OBJECT }];
  }
  const entries = Object.entries(models);
  const issues: Issue[] =
    entries.length > MAX_MODELS ? [{ path: "models", reason: `at most ${MAX_MODELS} models` }] : [];
  for (const [name, spec] of entries) {
    issues.push(...modelIssues(name, spec, harnesses));
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

function profileCrossIssues(
  name: string,
  spec: Record<string, unknown>,
  models: Record<string, unknown>,
  profileNames: string[],
  harnesses: readonly string[],
  modelWellFormed: boolean,
): Issue[] {
  const path = `profiles.${name}`;
  const issues: Issue[] = [];
  // An unknown harness is already reported at `.harness`; deriving a second
  // "model does not support this harness" from it would only be noise.
  const declared = spec["harness"];
  const harness = typeof declared === "string" && harnesses.includes(declared) ? declared : "";
  if (modelWellFormed && typeof spec["model"] === "string" && spec["model"] !== "") {
    const modelId = spec["model"];
    const modelSpec = models[modelId];
    if (!isPlainObject(modelSpec)) {
      issues.push({ path: `${path}.model`, reason: "no such model id" });
    } else if (harness !== "") {
      const harnessList = modelSpec["harnesses"];
      if (!Array.isArray(harnessList) || !harnessList.includes(harness)) {
        issues.push({ path: `${path}.model`, reason: "model does not support this harness" });
      }
    }
  }
  if ("allowed_models" in spec && Array.isArray(spec["allowed_models"])) {
    spec["allowed_models"].forEach((entry: unknown, index: number) => {
      const entryPath = `${path}.allowed_models[${index}]`;
      if (typeof entry !== "string") {
        issues.push({ path: entryPath, reason: MUST_BE_STRING });
        return;
      }
      if (!isValidAllowedModelEntry(entry, MAX_MODEL_LEN)) {
        issues.push({ path: entryPath, reason: "invalid model id or pattern" });
        return;
      }
      const modelSpec = models[entry];
      if (isPlainObject(modelSpec)) {
        if (harness !== "") {
          const harnessList = modelSpec["harnesses"];
          if (!Array.isArray(harnessList) || !harnessList.includes(harness)) {
            issues.push({ path: entryPath, reason: "model does not support this harness" });
          }
        }
        return;
      }
      const matches = Object.entries(models).some(([id, raw]) => {
        if (!isPlainObject(raw)) {
          return false;
        }
        const harnessList = raw["harnesses"];
        if (harness !== "" && (!Array.isArray(harnessList) || !harnessList.includes(harness))) {
          return false;
        }
        const slug = typeof raw["slug"] === "string" ? raw["slug"] : "";
        return modelAllowEntryMatches(entry, id, slug);
      });
      if (!matches) {
        issues.push({ path: entryPath, reason: "no catalog model matches this pattern" });
      }
    });
  }
  // A malformed allowlist makes membership undefined — the entry issues above say enough.
  const allowlistWellFormed = !issues.some((issue) =>
    issue.path.startsWith(`${path}.allowed_models`));
  if (
    modelWellFormed
    && allowlistWellFormed
    && typeof spec["model"] === "string"
    && spec["model"] !== ""
    && Array.isArray(spec["allowed_models"])
    && spec["allowed_models"].length > 0
  ) {
    const modelId = spec["model"];
    const modelSpec = models[modelId];
    const slug = isPlainObject(modelSpec) && typeof modelSpec["slug"] === "string"
      ? modelSpec["slug"]
      : "";
    const allowed = spec["allowed_models"].some(
      (entry) => typeof entry === "string" && modelAllowEntryMatches(entry, modelId, slug),
    );
    if (!allowed) {
      issues.push({ path: `${path}.model`, reason: "not in allowed_models" });
    }
  }
  if ("fallback" in spec && typeof spec["fallback"] === "string" && spec["fallback"] !== "") {
    if (!profileNames.includes(spec["fallback"])) {
      issues.push({ path: `${path}.fallback`, reason: "no such profile" });
    }
    if (spec["fallback"] === name) {
      issues.push({ path: `${path}.fallback`, reason: "must not reference itself" });
    }
  }
  return issues;
}

function profileIssues(
  name: string,
  spec: unknown,
  harnesses: readonly string[],
  models: Record<string, unknown>,
  profileNames: string[],
): Issue[] {
  const path = `profiles.${name}`;
  const issues: Issue[] = PROFILE_NAME.test(name) ? [] : [{ path, reason: "invalid name" }];
  if (!isPlainObject(spec)) {
    issues.push({ path, reason: MUST_BE_OBJECT });
    return issues;
  }
  issues.push(...unknownKeyIssues(spec, PROFILE_KEYS, path));
  issues.push(...harnessIssues(`${path}.harness`, spec, harnesses));
  let modelWellFormed = true;
  if ("model" in spec) {
    const modelIssues = textIssues(`${path}.model`, spec["model"], MAX_MODEL_LEN);
    issues.push(...modelIssues);
    modelWellFormed = modelIssues.length === 0;
  } else {
    modelWellFormed = false;
  }
  if ("allowed_models" in spec) {
    issues.push(...stringArrayIssues(`${path}.allowed_models`, spec["allowed_models"], MAX_TAGS, MAX_MODEL_LEN));
  }
  if ("description" in spec) {
    issues.push(...textIssues(`${path}.description`, spec["description"], MAX_DESCRIPTION_LEN));
  }
  if ("cost" in spec) {
    issues.push(...enumIssues(`${path}.cost`, spec["cost"], COST_VALUES));
  }
  if ("quality" in spec) {
    issues.push(...enumIssues(`${path}.quality`, spec["quality"], QUALITY_VALUES));
  }
  if ("speed" in spec) {
    issues.push(...enumIssues(`${path}.speed`, spec["speed"], SPEED_VALUES));
  }
  if ("risk" in spec) {
    issues.push(...enumIssues(`${path}.risk`, spec["risk"], RISK_VALUES));
  }
  if ("enabled" in spec && typeof spec["enabled"] !== "boolean") {
    issues.push({ path: `${path}.enabled`, reason: MUST_BE_BOOLEAN });
  }
  if ("tags" in spec) {
    issues.push(...stringArrayIssues(`${path}.tags`, spec["tags"], MAX_TAGS, MAX_TAG_LEN));
  }
  if ("strengths" in spec) {
    issues.push(...stringArrayIssues(`${path}.strengths`, spec["strengths"], MAX_TAGS, MAX_TAG_LEN));
  }
  if ("avoid_for" in spec) {
    issues.push(...stringArrayIssues(`${path}.avoid_for`, spec["avoid_for"], MAX_TAGS, MAX_TAG_LEN));
  }
  if ("min_complexity" in spec) {
    issues.push(...enumIssues(`${path}.min_complexity`, spec["min_complexity"], COMPLEXITY_VALUES));
  }
  if ("max_complexity" in spec) {
    issues.push(...enumIssues(`${path}.max_complexity`, spec["max_complexity"], COMPLEXITY_VALUES));
  }
  if ("parallel_ok" in spec && typeof spec["parallel_ok"] !== "boolean") {
    issues.push({ path: `${path}.parallel_ok`, reason: MUST_BE_BOOLEAN });
  }
  if ("priority" in spec && !isIntegerInRange(spec["priority"], MIN_PRIORITY, MAX_PRIORITY)) {
    issues.push({
      path: `${path}.priority`,
      reason: `must be an integer ${MIN_PRIORITY}-${MAX_PRIORITY}`,
    });
  }
  if ("fallback" in spec) {
    issues.push(...textIssues(`${path}.fallback`, spec["fallback"], MAX_MODEL_LEN));
  }
  if ("example_tasks" in spec) {
    issues.push(...stringArrayIssues(`${path}.example_tasks`, spec["example_tasks"], MAX_EXAMPLE_TASKS, MAX_EXAMPLE_LEN));
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
  issues.push(...profileCrossIssues(name, spec, models, profileNames, harnesses, modelWellFormed));
  return issues;
}

function profilesMapIssues(
  profiles: unknown,
  harnesses: readonly string[],
  models: Record<string, unknown>,
): Issue[] {
  if (!isPlainObject(profiles)) {
    return [{ path: "profiles", reason: MUST_BE_OBJECT }];
  }
  const entries = Object.entries(profiles);
  const profileNames = entries.map(([name]) => name);
  const issues: Issue[] =
    entries.length > MAX_PROFILES ? [{ path: "profiles", reason: `at most ${MAX_PROFILES} profiles` }] : [];
  for (const [name, spec] of entries) {
    issues.push(...profileIssues(name, spec, harnesses, models, profileNames));
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
  const models = isPlainObject(document["models"]) ? document["models"] : {};
  if ("settings" in document) {
    issues.push(...settingsIssues(document["settings"], document["profiles"], harnesses));
  }
  if ("models" in document) {
    issues.push(...modelsMapIssues(document["models"], harnesses));
  }
  if ("profiles" in document) {
    issues.push(...profilesMapIssues(document["profiles"], harnesses, models));
  }
  return issues;
}

// Exported for suggestions-validator reuse.
export { CONFIDENCE_VALUES };
