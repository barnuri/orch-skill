import { expect, test } from "bun:test";

import { SETTINGS_KEYS } from "./rules";

test("stale_minutes is a known setting", () => {
  expect(SETTINGS_KEYS).toContain("stale_minutes");
});

import { profilesIssues } from "./profiles-validator";

test("stale_minutes must be an integer >= 1", () => {
  const bad = profilesIssues({ settings: { stale_minutes: 0 }, profiles: {}, models: {} }, []);
  expect(bad.some((i) => i.path === "settings.stale_minutes")).toBe(true);
  const ok = profilesIssues({ settings: { stale_minutes: 10 }, profiles: {}, models: {} }, []);
  expect(ok.some((i) => i.path === "settings.stale_minutes")).toBe(false);
});
