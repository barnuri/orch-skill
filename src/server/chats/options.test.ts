import { describe, expect, test } from "bun:test";

import { TempHome } from "../test-support/temp-home";
import { buildOptions, resolveLaunch } from "./options";

const HARNESSES = ["claude", "copilot", "pi"];

function home(doc: unknown): string {
  const h = TempHome.create();
  h.write("profiles.json", JSON.stringify(doc));
  return h.path;
}

const DOC = {
  settings: { default_profile: "c-main", disabled_harnesses: ["pi"] },
  models: {
    "m-a": { slug: "alpha", harnesses: ["claude"], description: "A" },
    "m-b": { slug: "beta", harnesses: ["claude"], behaves_as: "claude-haiku" },
    "hub-x": { slug: "llama_swap/x", harnesses: ["claude", "pi"] },
    "cp-1": { slug: "cp1", harnesses: ["copilot"] },
  },
  profiles: {
    "c-main": { harness: "claude", model: "m-a", description: "main", flags: ["--flag"], env: { LIT: "literal", FROM: "${SOME_TEST_VAR_X}" }, auth: [] },
    "c-narrow": { harness: "claude", model: "m-a", allowed_models: ["m-a"] },
    "c-hub": { harness: "claude", model: "hub-x", allowed_models: ["llama_swap*"], auth: ["ORCH_TEST_UNSET_AUTH"] },
    "c-off": { harness: "claude", model: "m-a", enabled: false },
    "cp-main": { harness: "copilot", model: "cp-1" },
    "pi-main": { harness: "pi", model: "hub-x" },
  },
};

describe("chat options", () => {
  const opts = buildOptions(home(DOC), HARNESSES);
  const claude = opts.harnesses.find((h) => h.id === "claude");

  test("lists every harness with its profiles and models", () => {
    expect(opts.harnesses.map((h) => h.id)).toEqual(HARNESSES);
    expect(claude?.persistent).toBe(true);
    expect(opts.harnesses.find((h) => h.id === "copilot")?.persistent).toBe(false);
    expect(opts.default_profile).toBe("c-main");
    expect(opts.default_harness).toBe("claude");
  });

  test("allowed_models narrows by id and by prefix pattern; no list means every model of the harness", () => {
    const by = (n: string): string[] => (claude?.profiles.find((p) => p.name === n)?.models ?? []).map((m) => m.id);
    expect(by("c-main")).toEqual(["m-a", "m-b", "hub-x"]);
    expect(by("c-narrow")).toEqual(["m-a"]);
    expect(by("c-hub")).toEqual(["hub-x"]);
  });

  test("the profile's own model is flagged default", () => {
    expect(claude?.profiles.find((p) => p.name === "c-main")?.models.filter((m) => m.default).map((m) => m.id)).toEqual(["m-a"]);
  });

  test("a disabled harness disables its profiles; a disabled profile is off on its own", () => {
    const pi = opts.harnesses.find((h) => h.id === "pi");
    expect([pi?.enabled, pi?.profiles[0]?.enabled]).toEqual([false, false]);
    expect(claude?.enabled).toBe(true);
    expect(claude?.profiles.find((p) => p.name === "c-off")?.enabled).toBe(false);
    expect(claude?.profiles.find((p) => p.name === "c-main")?.enabled).toBe(true);
  });

  test("a profile with unset auth is not configured and says why", () => {
    const p = claude?.profiles.find((x) => x.name === "c-hub");
    expect([p?.configured, p?.problem]).toEqual([false, "required auth env var ORCH_TEST_UNSET_AUTH is not set"]);
  });

  test("a missing or broken profiles.json gives empty profile lists, not an error", () => {
    const h = TempHome.create();
    h.write("profiles.json", "{ nope");
    expect(buildOptions(h.path, HARNESSES).harnesses.every((x) => x.profiles.length === 0)).toBe(true);
  });
});

describe("resolveLaunch", () => {
  const h = home(DOC);
  const err = (harness: string, profile: string, model: string | null): string => {
    const r = resolveLaunch(h, harness, profile, model);
    return r.ok ? "" : r.error;
  };

  test("rejects a disabled harness, a disabled profile, a foreign profile and an unknown profile", () => {
    expect(err("pi", "pi-main", null)).toContain("disabled");
    expect(err("claude", "c-off", null)).toContain("disabled");
    expect(err("copilot", "c-main", null)).toContain("belongs to harness");
    expect(err("claude", "nope", null)).toContain("unknown profile");
  });

  test("rejects a model outside the profile's list, accepts one inside", () => {
    expect(err("claude", "c-narrow", "m-b")).toContain("not allowed");
    expect(err("claude", "c-narrow", "cp-1")).toContain("not allowed");
    expect(err("claude", "c-narrow", "m-a")).toBe("");
    expect(err("claude", "c-hub", "m-a")).toContain("not allowed");
  });

  test("an unset env reference or auth variable is refused", () => {
    expect(err("claude", "c-main", null)).toContain("SOME_TEST_VAR_X");
    expect(err("claude", "c-hub", null)).toContain("ORCH_TEST_UNSET_AUTH");
  });

  test("returns slug, flags, resolved env and behaves_as", () => {
    process.env.SOME_TEST_VAR_X = "resolved";
    try {
      const r = resolveLaunch(h, "claude", "c-main", "m-b");
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.launch).toEqual({ harness: "claude", modelSlug: "beta", behavesAs: "claude-haiku", flags: ["--flag"], env: { LIT: "literal", FROM: "resolved" } });
      }
      const dflt = resolveLaunch(h, "claude", "c-main", null);
      expect(dflt.ok && dflt.launch.modelSlug).toBe("alpha");
    } finally {
      delete process.env.SOME_TEST_VAR_X;
    }
  });

  test("${PROFILE_MODEL} and a derived LLM_HUB_V1_URL resolve like profile_load", () => {
    const h2 = home({
      models: { m: { slug: "slug-1", harnesses: ["claude"] } },
      profiles: { p: { harness: "claude", model: "m", env: { ANTHROPIC_MODEL: "${PROFILE_MODEL}", URL: "${LLM_HUB_V1_URL}" } } },
    });
    process.env.LLM_HUB_URL = "http://hub:1/v1/";
    const saved = process.env.LLM_HUB_V1_URL;
    delete process.env.LLM_HUB_V1_URL;
    try {
      const r = resolveLaunch(h2, "claude", "p", null);
      expect(r.ok && r.launch.env).toEqual({ ANTHROPIC_MODEL: "slug-1", URL: "http://hub:1/v1", LLM_HUB_V1_URL: "http://hub:1/v1" });
    } finally {
      delete process.env.LLM_HUB_URL;
      if (saved !== undefined) {
        process.env.LLM_HUB_V1_URL = saved;
      }
    }
  });

  test("<home>/env names and the derived LLM_HUB_V1_URL reach the agent's env, for opencode's {env:NAME} inside OPENCODE_CONFIG_CONTENT", () => {
    const t = TempHome.create();
    t.write("profiles.json", JSON.stringify({
      models: { hub: { slug: "hub/smart-auto-balance", harnesses: ["opencode"] } },
      profiles: { oc: { harness: "opencode", model: "hub", flags: ["--pure"], auth: ["ORCH_TEST_HUB_URL_X"],
        env: { OPENCODE_CONFIG_CONTENT: "{\"provider\":{\"hub\":{\"options\":{\"baseURL\":\"{env:LLM_HUB_V1_URL}\"}}}}" } } },
    }));
    t.write("env", "ORCH_TEST_HUB_URL_X=set-in-file\nLLM_HUB_URL=http://hub:2\n");
    const saved = { url: process.env.LLM_HUB_URL, v1: process.env.LLM_HUB_V1_URL };
    delete process.env.LLM_HUB_URL;
    delete process.env.LLM_HUB_V1_URL;
    try {
      const r = resolveLaunch(t.path, "opencode", "oc", null);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.launch.modelSlug).toBe("hub/smart-auto-balance");
        expect(r.launch.env.LLM_HUB_V1_URL).toBe("http://hub:2/v1");
        expect(r.launch.env.LLM_HUB_URL).toBe("http://hub:2");
        expect(r.launch.env.ORCH_TEST_HUB_URL_X).toBe("set-in-file");
        expect(r.launch.env.OPENCODE_CONFIG_CONTENT).toContain("{env:LLM_HUB_V1_URL}");
        expect(r.launch.env.PROFILE_MODEL).toBeUndefined();
      }
    } finally {
      if (saved.url !== undefined) {
        process.env.LLM_HUB_URL = saved.url;
      }
      if (saved.v1 !== undefined) {
        process.env.LLM_HUB_V1_URL = saved.v1;
      }
    }
  });
});
