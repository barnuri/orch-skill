import { describe, expect, test } from "bun:test";

import type { ProfilesDocument } from "../../../shared/types/profiles-document";
import { profileSwitchDecision } from "./profile-switch";

function document(): ProfilesDocument {
  return {
    settings: { default_profile: "primary" },
    models: {},
    profiles: {
      primary: { harness: "claude", enabled: true },
      alternate: { harness: "copilot", enabled: false },
    },
  };
}

describe("profileSwitchDecision", () => {
  test("disables an enabled profile without changing the loaded document or other profiles", () => {
    const loaded = document();
    const decision = profileSwitchDecision(loaded, "primary", false);
    expect(decision.kind).toBe("ready");
    if (decision.kind !== "ready") {
      return;
    }
    expect(decision.document.profiles.primary?.enabled).toBe(false);
    expect(decision.document.profiles.alternate?.enabled).toBe(false);
    expect(loaded.profiles.primary?.enabled).toBe(true);
  });

  test("enables a disabled profile", () => {
    const decision = profileSwitchDecision(document(), "alternate", false);
    expect(decision.kind).toBe("ready");
    if (decision.kind === "ready") {
      expect(decision.document.profiles.alternate?.enabled).toBe(true);
    }
  });

  test("keeps an unsaved draft by refusing to create a save document", () => {
    expect(profileSwitchDecision(document(), "primary", true)).toEqual({ kind: "dirty" });
  });

  test("reports a missing profile instead of saving a stale document", () => {
    expect(profileSwitchDecision(document(), "deleted", false)).toEqual({ kind: "missing" });
  });
});
