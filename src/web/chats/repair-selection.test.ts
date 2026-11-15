import { describe, expect, test } from "bun:test";

import type { ChatOptions } from "../lib/chat-types";
import { repairSelection } from "./repair-selection";

const model = (id: string, d = false) => ({ id, label: id, slug: id, description: "", default: d });
const profile = (name: string, models: string[], over: Record<string, unknown> = {}) => ({ name, description: "", enabled: true, configured: true, problem: null, models: models.map((m, i) => model(m, i === 0)), ...over });
const harness = (id: string, profiles: unknown[], over: Record<string, unknown> = {}) => ({ id, label: id, enabled: true, available: true, persistent: false, profiles, ...over });
const options = (harnesses: unknown[]): ChatOptions => ({ harnesses, default_harness: "opencode", default_profile: "smart" }) as ChatOptions;

const opts = options([
  harness("opencode", [profile("hub", ["q"], { enabled: false }), profile("smart", ["auto", "other"])]),
  harness("claude", [profile("main", ["sonnet"])], { enabled: false }),
]);

describe("repairSelection", () => {
  test("an unknown or disabled profile on a usable harness becomes the profile the pickers show", () => {
    expect(repairSelection(opts, { harness: "opencode", profile: "nope", model: null })).toEqual({ harness: "opencode", profile: "smart", model: "auto" });
    expect(repairSelection(opts, { harness: "opencode", profile: "hub", model: null })).toEqual({ harness: "opencode", profile: "smart", model: "auto" });
  });

  test("a model the profile no longer allows becomes its default; an allowed or default (null) model is left alone", () => {
    expect(repairSelection(opts, { harness: "opencode", profile: "smart", model: "gone" })).toEqual({ harness: "opencode", profile: "smart", model: "auto" });
    expect(repairSelection(opts, { harness: "opencode", profile: "smart", model: "other" })).toBeNull();
    expect(repairSelection(opts, { harness: "opencode", profile: "smart", model: null })).toBeNull();
  });

  test("a disabled or unknown harness is not repaired: the user switches harness", () => {
    expect(repairSelection(opts, { harness: "claude", profile: "nope", model: null })).toBeNull();
    expect(repairSelection(opts, { harness: "bogus", profile: "x", model: null })).toBeNull();
  });
});
