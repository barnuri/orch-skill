import { describe, expect, test } from "bun:test";
import { choiceFromUsage, harnessUsage, profileAllowedFor, profileUsage, usageFromChoice, usageRefusal } from "./profile-usage";

const doc = {
  settings: { disabled_harnesses: ["pi"], harness_usage: { opencode: ["chat"], copilot: ["runs"] } },
  profiles: {
    both: { harness: "claude" },
    chat: { harness: "claude", usage: ["chat"] },
    runs: { harness: "claude", usage: ["runs"] },
    oc: { harness: "opencode" },
    cp: { harness: "copilot", usage: ["chat", "runs"] },
    off: { harness: "pi" },
  },
};

describe("effective availability", () => {
  test("a missing usage means both", () => {
    expect(profileUsage(doc, "both")).toEqual(["chat", "runs"]);
    expect(harnessUsage(doc, "claude")).toEqual(["chat", "runs"]);
  });
  test("defaults.usage is inherited unless the profile sets its own", () => {
    const d = { ...doc, defaults: { usage: ["runs"] } };
    expect(profileUsage(d, "both")).toEqual(["runs"]);
    expect(profileUsage(d, "chat")).toEqual(["chat"]);
  });
  test("profile AND harness must allow the use", () => {
    expect(profileAllowedFor(doc, "chat", "chat")).toBe(true);
    expect(profileAllowedFor(doc, "chat", "runs")).toBe(false);
    expect(profileAllowedFor(doc, "oc", "chat")).toBe(true);
    expect(profileAllowedFor(doc, "oc", "runs")).toBe(false);
    expect(profileAllowedFor(doc, "cp", "chat")).toBe(false);
    expect(profileAllowedFor(doc, "cp", "runs")).toBe(true);
  });
  test("a disabled harness allows nothing; an unknown profile is not allowed", () => {
    expect(profileAllowedFor(doc, "off", "chat")).toBe(false);
    expect(profileAllowedFor(doc, "nope", "runs")).toBe(false);
  });
  test("refusals name the profile or harness and the setting to change", () => {
    expect(usageRefusal(doc, "chat", "runs")).toContain("profile chat is chat-only (profiles.chat.usage)");
    expect(usageRefusal(doc, "runs", "chat")).toContain("profile runs is runs-only");
    expect(usageRefusal(doc, "oc", "runs")).toContain("harness opencode is chat-only (settings.harness_usage.opencode)");
    expect(usageRefusal(doc, "both", "chat")).toBeNull();
  });
  test("choices convert both ways", () => {
    expect(usageFromChoice("both")).toEqual(["chat", "runs"]);
    expect(choiceFromUsage(["runs"])).toBe("runs");
    expect(choiceFromUsage(usageFromChoice("both"))).toBe("both");
  });
  test("garbage values fall back to both", () => {
    expect(profileUsage({ profiles: { x: { usage: [] } } }, "x")).toEqual(["chat", "runs"]);
    expect(profileUsage({ profiles: { x: { usage: "chat" } } }, "x")).toEqual(["chat", "runs"]);
  });
});
