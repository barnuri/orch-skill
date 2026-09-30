import { describe, expect, test } from "bun:test";

import type { ProfilesDocument } from "../../../shared/types/profiles-document";
import { visibleProfiles } from "./profile-filter";

const profiles: ProfilesDocument["profiles"] = {
  on: { harness: "claude", enabled: true },
  implicit: { harness: "copilot" },
  off: { harness: "opencode", enabled: false },
};

describe("visibleProfiles", () => {
  test("shows every profile by default in file order", () => {
    expect(visibleProfiles(profiles, false).map(([name]) => name)).toEqual(["on", "implicit", "off"]);
  });

  test("hides only explicitly disabled profiles", () => {
    expect(visibleProfiles(profiles, true).map(([name]) => name)).toEqual(["on", "implicit"]);
  });

  test("returns an empty filtered list without changing the catalog", () => {
    const allDisabled: ProfilesDocument["profiles"] = { off: { harness: "opencode", enabled: false } };
    expect(visibleProfiles(allDisabled, true)).toEqual([]);
    expect(Object.keys(allDisabled)).toEqual(["off"]);
  });
});
