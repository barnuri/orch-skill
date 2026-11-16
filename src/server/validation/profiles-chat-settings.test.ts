import { describe, expect, test } from "bun:test";

import type { Issue } from "../../shared/types/issue";
import { profilesIssues } from "./profiles-validator";

const HARNESSES: readonly string[] = ["claude", "cursor-agent", "opencode", "local-llm", "copilot", "pi"];

function issuesWith(settings: Record<string, unknown>): Issue[] {
  const doc = {
    settings: { default_profile: "x", ...settings },
    models: { m: { slug: "m", harnesses: ["claude"] } },
    profiles: { x: { harness: "claude", model: "m" } },
  };
  return profilesIssues(doc, HARNESSES);
}

describe("chat settings in profiles.json", () => {
  test("the defaults and good values are accepted", () => {
    expect(issuesWith({})).toEqual([]);
    expect(issuesWith({ schedule_grace_hours: 0, monitor_allow_link_local: false, chat_roots: ["~/sandbox/private", "/srv/work"] })).toEqual([]);
    expect(issuesWith({ schedule_grace_hours: 72, monitor_allow_link_local: true, chat_roots: ["~"] })).toEqual([]);
  });

  test("schedule_grace_hours is a whole number from 0 to 72", () => {
    for (const bad of [-1, 73, 1.5, "6", null]) {
      expect(issuesWith({ schedule_grace_hours: bad })).toEqual([{ path: "settings.schedule_grace_hours", reason: "must be an integer 0-72" }]);
    }
  });

  test("monitor_allow_link_local is a boolean", () => {
    expect(issuesWith({ monitor_allow_link_local: "yes" })).toEqual([{ path: "settings.monitor_allow_link_local", reason: "must be a boolean" }]);
  });

  test("chat_roots is a list of absolute or ~ folders without .. segments", () => {
    expect(issuesWith({ chat_roots: "~/a" })).toEqual([{ path: "settings.chat_roots", reason: "must be an array" }]);
    expect(issuesWith({ chat_roots: ["relative/dir", "/ok", "/a/../b", "", 5] })).toEqual([
      { path: "settings.chat_roots[0]", reason: "must be an absolute path, or start with ~/" },
      { path: "settings.chat_roots[2]", reason: "must not contain a .. segment" },
      { path: "settings.chat_roots[3]", reason: "must not be empty" },
      { path: "settings.chat_roots[4]", reason: "must be a string" },
    ]);
    expect(issuesWith({ chat_roots: Array.from({ length: 21 }, (_, i) => `/r${i}`) })).toEqual([{ path: "settings.chat_roots", reason: "at most 20 entries" }]);
  });
});
