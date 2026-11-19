import { expect, test } from "bun:test";
import { nodeModelOverride, type Catalog } from "../../core/adapters/routing.ts";

const cat: Catalog = {
  profiles: {
    "p-claude": { harness: "claude", model: "claude-sonnet", allowed_models: ["claude-*"] },
    "p-oc": { harness: "opencode", model: "m-gw", allowed_models: [] },
    "p-smart": { harness: "claude", model: "hub/smart-auto-balance", allowed_models: [] },
  },
  models: {
    "claude-sonnet": { slug: "claude-sonnet", harnesses: ["claude"] },
    "claude-opus": { slug: "claude-opus", harnesses: ["claude"] },
    "m-gw": { slug: "gw/model", harnesses: ["opencode"] },
  },
};

test("empty or smart-auto node model leaves the profile model in charge", () => {
  expect(nodeModelOverride(cat, "p-claude", "")).toEqual({ modelId: "", error: "" });
  expect(nodeModelOverride(cat, "p-smart", "hub/smart-auto-deep")).toEqual({ modelId: "", error: "" });
});

test("a concrete model on the profile harness overrides the profile model", () => {
  expect(nodeModelOverride(cat, "p-claude", "claude-opus")).toEqual({ modelId: "claude-opus", error: "" });
});

test("a slug resolves to its catalog id on the profile harness", () => {
  expect(nodeModelOverride(cat, "p-oc", "gw/model")).toEqual({ modelId: "m-gw", error: "" });
});

test("a model on another harness fails with the profile and harness named", () => {
  const r = nodeModelOverride(cat, "p-oc", "claude-opus");
  expect(r.modelId).toBe("");
  expect(r.error).toMatch(/model claude-opus is not served by profile p-oc \(harness opencode\)/);
});

test("a model outside allowed_models fails", () => {
  const c: Catalog = { ...cat, profiles: { ...cat.profiles, "p-narrow": { harness: "claude", model: "claude-sonnet", allowed_models: ["claude-sonnet"] } } };
  expect(nodeModelOverride(c, "p-narrow", "claude-opus").error).toMatch(/not in allowed_models of profile p-narrow/);
});
