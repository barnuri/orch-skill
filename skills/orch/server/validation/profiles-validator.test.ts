import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { profilesIssues } from "./profiles-validator";

import type { Issue } from "../../shared/types/issue";

const TEMPLATE_PATH: string = resolve(import.meta.dir, "../../templates/profiles.json");
const HARNESSES: readonly string[] = ["claude", "cursor-agent", "opencode", "local-llm"];

type Mutable = Record<string, unknown>;

function loadTemplate(): Mutable {
  return JSON.parse(readFileSync(TEMPLATE_PATH, "utf8")) as Mutable;
}

/** A fresh template copy with one profile (`x`) so paths in assertions stay short. */
function documentWithProfile(spec: Mutable): Mutable {
  const document = loadTemplate();
  document["settings"] = { default_profile: "x", retention_days: 7, budget_threshold: 85 };
  document["models"] = {
    "claude-sonnet": { slug: "sonnet", harnesses: ["claude"], description: "workhorse" },
    "local-lfm-8b": { slug: "llama_swap/lfm2.5-8b-a1b", harnesses: ["claude"], description: "hub" },
  };
  document["profiles"] = { x: { harness: "claude", model: "claude-sonnet", ...spec } };
  return document;
}

function issuesFor(document: unknown): Issue[] {
  return profilesIssues(document, HARNESSES);
}

describe("profilesIssues", () => {
  test("the shipped template has no issues", () => {
    expect(issuesFor(loadTemplate())).toEqual([]);
  });

  test("non-object root is reported at $", () => {
    expect(issuesFor([])).toEqual([{ path: "$", reason: "must be an object" }]);
    expect(issuesFor(null)).toEqual([{ path: "$", reason: "must be an object" }]);
  });

  test("missing settings, models and profiles are all required", () => {
    expect(issuesFor({})).toEqual([
      { path: "settings", reason: "required" },
      { path: "models", reason: "required" },
      { path: "profiles", reason: "required" },
    ]);
  });

  test("unknown root key", () => {
    const document = loadTemplate();
    document["extra"] = 1;
    expect(issuesFor(document)).toEqual([{ path: "extra", reason: "unknown key" }]);
  });

  test("unknown settings key", () => {
    const document = loadTemplate();
    (document["settings"] as Mutable)["theme"] = "dark";
    expect(issuesFor(document)).toEqual([{ path: "settings.theme", reason: "unknown key" }]);
  });

  test("harness outside the list carries the exact path and the allowed values", () => {
    const document = documentWithProfile({ harness: "codex" });
    expect(issuesFor(document)).toEqual([
      { path: "profiles.x.harness", reason: "must be one of claude, cursor-agent, opencode, local-llm" },
    ]);
  });

  test("missing harness is required", () => {
    const document = documentWithProfile({});
    delete (((document["profiles"] as Mutable)["x"]) as Mutable)["harness"];
    expect(issuesFor(document)).toEqual([{ path: "profiles.x.harness", reason: "required" }]);
  });

  test("default_profile must name an existing profile", () => {
    const document = loadTemplate();
    (document["settings"] as Mutable)["default_profile"] = "missing";
    expect(issuesFor(document)).toEqual([
      { path: "settings.default_profile", reason: "no such profile" },
    ]);
  });

  test("default_profile is empty iff there are no profiles", () => {
    const emptyDefaultWithProfiles = loadTemplate();
    (emptyDefaultWithProfiles["settings"] as Mutable)["default_profile"] = "";
    expect(issuesFor(emptyDefaultWithProfiles)).toEqual([
      { path: "settings.default_profile", reason: "no such profile" },
    ]);

    const namedDefaultWithoutProfiles = loadTemplate();
    namedDefaultWithoutProfiles["profiles"] = {};
    expect(issuesFor(namedDefaultWithoutProfiles)).toEqual([
      { path: "settings.default_profile", reason: "must be empty when there are no profiles" },
    ]);

    const emptyDefaultWithoutProfiles = loadTemplate();
    emptyDefaultWithoutProfiles["profiles"] = {};
    (emptyDefaultWithoutProfiles["settings"] as Mutable)["default_profile"] = "";
    expect(issuesFor(emptyDefaultWithoutProfiles)).toEqual([]);
  });

  test("retention_days rejects booleans and out-of-range values", () => {
    const document = loadTemplate();
    (document["settings"] as Mutable)["retention_days"] = true;
    expect(issuesFor(document)).toEqual([
      { path: "settings.retention_days", reason: "must be an integer 0-3650" },
    ]);
    (document["settings"] as Mutable)["retention_days"] = 3651;
    expect(issuesFor(document)).toHaveLength(1);
    (document["settings"] as Mutable)["retention_days"] = 0;
    expect(issuesFor(document)).toEqual([]);
  });

  test("budget_threshold must be an integer 0-100", () => {
    const document = loadTemplate();
    (document["settings"] as Mutable)["budget_threshold"] = 101;
    expect(issuesFor(document)).toEqual([
      { path: "settings.budget_threshold", reason: "must be an integer 0-100" },
    ]);
  });

  test("profile names must match PROFILE_NAME", () => {
    const document = loadTemplate();
    (document["profiles"] as Mutable)[".bad"] = { harness: "claude" };
    expect(issuesFor(document)).toEqual([{ path: "profiles..bad", reason: "invalid name" }]);
  });

  test("more than 64 profiles", () => {
    const document = loadTemplate();
    const profiles: Mutable = {};
    for (let index = 0; index < 65; index += 1) {
      profiles[`p${index}`] = { harness: "claude" };
    }
    document["profiles"] = profiles;
    (document["settings"] as Mutable)["default_profile"] = "p0";
    expect(issuesFor(document)).toEqual([{ path: "profiles", reason: "at most 64 profiles" }]);
  });

  test("profile value must be an object", () => {
    const document = documentWithProfile({});
    (document["profiles"] as Mutable)["x"] = "claude";
    expect(issuesFor(document)).toEqual([{ path: "profiles.x", reason: "must be an object" }]);
  });

  test("unknown profile key", () => {
    const document = documentWithProfile({ temperature: 0.2 });
    expect(issuesFor(document)).toEqual([{ path: "profiles.x.temperature", reason: "unknown key" }]);
  });

  test("model must be a short string without control characters", () => {
    expect(issuesFor(documentWithProfile({ model: 3 }))).toEqual([
      { path: "profiles.x.model", reason: "must be a string" },
    ]);
    expect(issuesFor(documentWithProfile({ model: "a".repeat(129) }))).toEqual([
      { path: "profiles.x.model", reason: "at most 128 characters" },
    ]);
    expect(issuesFor(documentWithProfile({ model: "op\tus" }))).toEqual([
      { path: "profiles.x.model", reason: "must not contain control characters" },
    ]);
  });

  test("flags must be an array of strings", () => {
    expect(issuesFor(documentWithProfile({ flags: "--verbose" }))).toEqual([
      { path: "profiles.x.flags", reason: "must be an array" },
    ]);
    expect(issuesFor(documentWithProfile({ flags: ["--ok", 7] }))).toEqual([
      { path: "profiles.x.flags[1]", reason: "must be a string" },
    ]);
  });

  test("flag with a newline is reported at its index (flags are read line-by-line)", () => {
    expect(issuesFor(documentWithProfile({ flags: ["--a\n--b"] }))).toEqual([
      { path: "profiles.x.flags[0]", reason: "must not contain control characters" },
    ]);
  });

  test("empty and oversized flags", () => {
    expect(issuesFor(documentWithProfile({ flags: [""] }))).toEqual([
      { path: "profiles.x.flags[0]", reason: "must not be empty" },
    ]);
    expect(issuesFor(documentWithProfile({ flags: ["x".repeat(257)] }))).toEqual([
      { path: "profiles.x.flags[0]", reason: "at most 256 characters" },
    ]);
    const tooMany = Array.from({ length: 33 }, () => "--f");
    expect(issuesFor(documentWithProfile({ flags: tooMany }))).toEqual([
      { path: "profiles.x.flags", reason: "at most 32 flags" },
    ]);
  });

  test("env must be an object with identifier keys", () => {
    expect(issuesFor(documentWithProfile({ env: [] }))).toEqual([
      { path: "profiles.x.env", reason: "must be an object" },
    ]);
    expect(issuesFor(documentWithProfile({ env: { "bad-name": "1" } }))).toEqual([
      { path: "profiles.x.env.bad-name", reason: "must be an identifier" },
    ]);
  });

  test("forbidden env keys: exact denylist and prefixes", () => {
    const forbidden = "forbidden — changes which code runs when the harness spawns";
    expect(issuesFor(documentWithProfile({ env: { NODE_OPTIONS: "--require x" } }))).toEqual([
      { path: "profiles.x.env.NODE_OPTIONS", reason: forbidden },
    ]);
    expect(issuesFor(documentWithProfile({ env: { LD_PRELOAD: "/tmp/x.so" } }))).toEqual([
      { path: "profiles.x.env.LD_PRELOAD", reason: forbidden },
    ]);
  });

  test("env values: strings only, bounded, no control characters", () => {
    expect(issuesFor(documentWithProfile({ env: { A: 1 } }))).toEqual([
      { path: "profiles.x.env.A", reason: "must be a string" },
    ]);
    expect(issuesFor(documentWithProfile({ env: { A: "v".repeat(1025) } }))).toEqual([
      { path: "profiles.x.env.A", reason: "at most 1024 characters" },
    ]);
    expect(issuesFor(documentWithProfile({ env: { A: "a\nb" } }))).toEqual([
      { path: "profiles.x.env.A", reason: "must not contain control characters" },
    ]);
    const env: Mutable = {};
    for (let index = 0; index < 33; index += 1) {
      env[`V${index}`] = "1";
    }
    expect(issuesFor(documentWithProfile({ env }))).toEqual([
      { path: "profiles.x.env", reason: "at most 32 variables" },
    ]);
  });

  test("a value containing ${ must be exactly one whole-value reference", () => {
    expect(issuesFor(documentWithProfile({ env: { BASE_URL: "${LLM_HUB_URL}/v1" } }))).toEqual([
      { path: "profiles.x.env.BASE_URL", reason: "a reference must be exactly ${NAME}" },
    ]);
    expect(issuesFor(documentWithProfile({ env: { BASE_URL: "${LLM_HUB_URL}" } }))).toEqual([]);
  });

  test("secret-looking keys must hold a reference, not a literal", () => {
    expect(issuesFor(documentWithProfile({ env: { MY_API_KEY: "sk-live" } }))).toEqual([
      { path: "profiles.x.env.MY_API_KEY", reason: "looks like a secret — use ${NAME}" },
    ]);
    expect(issuesFor(documentWithProfile({ env: { MY_API_KEY: "${MY_API_KEY}" } }))).toEqual([]);
    expect(issuesFor(documentWithProfile({ env: { DB_PASSWORD: "hunter2" } }))).toHaveLength(1);
  });

  test("auth must be an array of unique identifiers", () => {
    expect(issuesFor(documentWithProfile({ auth: "KEY" }))).toEqual([
      { path: "profiles.x.auth", reason: "must be an array" },
    ]);
    expect(issuesFor(documentWithProfile({ auth: ["KEY", "KEY"] }))).toEqual([
      { path: "profiles.x.auth[1]", reason: "duplicate" },
    ]);
    expect(issuesFor(documentWithProfile({ auth: ["not-an-id", 3] }))).toEqual([
      { path: "profiles.x.auth[0]", reason: "must be an identifier" },
      { path: "profiles.x.auth[1]", reason: "must be an identifier" },
    ]);
    const tooMany = Array.from({ length: 33 }, (_, index) => `K${index}`);
    expect(issuesFor(documentWithProfile({ auth: tooMany }))).toEqual([
      { path: "profiles.x.auth", reason: "at most 32 entries" },
    ]);
  });

  test("allowed_models accepts slug prefix patterns that match the harness", () => {
    const document = loadTemplate();
    const profiles = document["profiles"] as Mutable;
    profiles["hub"] = {
      harness: "claude",
      model: "local-lfm-8b",
      allowed_models: ["llama_swap*"],
      flags: [],
      env: {},
      auth: [],
    };
    expect(issuesFor(document)).toEqual([]);
  });

  test("allowed_models pattern with no matches is rejected", () => {
    const document = documentWithProfile({ allowed_models: ["no-such-prefix*"] });
    expect(issuesFor(document)).toEqual([
      { path: "profiles.x.allowed_models[0]", reason: "no catalog model matches this pattern" },
    ]);
  });

  test("profile model must fall inside allowed_models patterns", () => {
    const document = documentWithProfile({
      model: "claude-sonnet",
      allowed_models: ["llama_swap*"],
    });
    expect(issuesFor(document)).toEqual([
      { path: "profiles.x.model", reason: "not in allowed_models" },
    ]);
  });

  test("all issues are collected, not just the first", () => {
    const document = documentWithProfile({ harness: "codex", flags: [7] });
    (document["settings"] as Mutable)["budget_threshold"] = 101;
    const issues = issuesFor(document);
    expect(issues).toHaveLength(3);
    expect(issues.map((issue) => issue.path)).toEqual([
      "settings.budget_threshold",
      "profiles.x.harness",
      "profiles.x.flags[0]",
    ]);
  });
});
