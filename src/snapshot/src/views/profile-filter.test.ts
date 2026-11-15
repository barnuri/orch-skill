import { afterEach, describe, expect, test } from "bun:test";

import type { ProfilesDocument } from "../../../shared/types/profiles-document";
import { disabledHarnessSet, loadHideDisabled, offReason, saveHideDisabled, visibleProfiles } from "./profile-filter";

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

describe("a profile on a disabled harness", () => {
  test("is off even when the profile itself is enabled", () => {
    const off = new Set(["claude"]);
    expect(offReason({ harness: "claude", enabled: true }, off)).toBe("harness");
    expect(offReason({ harness: "claude" }, off)).toBe("harness");
  });

  test("names the profile as the reason only when its harness is fine", () => {
    const off = new Set(["claude"]);
    expect(offReason({ harness: "opencode", enabled: false }, off)).toBe("profile");
    expect(offReason({ harness: "opencode", enabled: true }, off)).toBeNull();
  });

  test("the harness reason wins when both apply, since enabling the profile would not help", () => {
    expect(offReason({ harness: "claude", enabled: false }, new Set(["claude"]))).toBe("harness");
  });

  test("is hidden by the hide-disabled filter", () => {
    const off = new Set(["copilot"]);
    expect(visibleProfiles(profiles, true, off).map(([name]) => name)).toEqual(["on"]);
    expect(visibleProfiles(profiles, false, off).map(([name]) => name)).toEqual(["on", "implicit", "off"]);
  });

  test("the set comes from settings.disabled_harnesses", () => {
    const doc = { settings: { disabled_harnesses: ["pi", "copilot"] }, profiles } as unknown as ProfilesDocument;
    expect([...disabledHarnessSet(doc)].sort()).toEqual(["copilot", "pi"]);
    expect(disabledHarnessSet({ settings: {}, profiles } as unknown as ProfilesDocument).size).toBe(0);
  });
});

describe("hide-disabled preference", () => {
  // `bun test` has no localStorage; a Map-backed stub stands in for the browser's.
  function stubStorage(storage: unknown): void {
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  }

  afterEach(() => {
    stubStorage(undefined);
  });

  test("defaults to showing everything", () => {
    const items = new Map<string, string>();
    stubStorage({ getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => items.set(k, v) });
    expect(loadHideDisabled()).toBe(false);
  });

  test("remembers the toggle across loads", () => {
    const items = new Map<string, string>();
    stubStorage({ getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => items.set(k, v) });
    saveHideDisabled(true);
    expect(loadHideDisabled()).toBe(true);
    saveHideDisabled(false);
    expect(loadHideDisabled()).toBe(false);
  });

  test("a blocked localStorage neither throws nor hides", () => {
    const boom = (): never => {
      throw new Error("blocked");
    };
    stubStorage({ getItem: boom, setItem: boom });
    expect(() => saveHideDisabled(true)).not.toThrow();
    expect(loadHideDisabled()).toBe(false);
  });
});
