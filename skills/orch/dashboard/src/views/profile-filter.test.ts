import { afterEach, describe, expect, test } from "bun:test";

import type { ProfilesDocument } from "../../../shared/types/profiles-document";
import { loadHideDisabled, saveHideDisabled, visibleProfiles } from "./profile-filter";

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
