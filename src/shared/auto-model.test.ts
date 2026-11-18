import { describe, expect, test } from "bun:test";

import { AUTO_UNKNOWN, autoLabel, isAutoSelector } from "./auto-model";

describe("isAutoSelector", () => {
  test("matches the hub and copilot auto selectors only", () => {
    for (const id of ["hub-smart-auto-balance", "hub/smart-auto-balance", "copilot-auto", "auto"]) {
      expect(isAutoSelector(id)).toBe(true);
    }
    for (const id of ["copilot-opus-5.5", "hub-claude-opus-5-5", "", null, undefined]) {
      expect(isAutoSelector(id)).toBe(false);
    }
  });
});

describe("autoLabel", () => {
  test("shows the real model once reported", () => {
    expect(autoLabel("claude-opus-5.5")).toBe("auto -> claude-opus-5.5");
    expect(autoLabel("hub/claude-sonnet-x")).toBe("auto -> claude-sonnet-x");
  });
  test("puts a tilde on a model that is only expected", () => {
    expect(autoLabel("claude-opus-5.5", true)).toBe("auto -> ~claude-opus-5.5");
  });
  test("says so when no model was reported", () => {
    expect(autoLabel(null)).toBe(AUTO_UNKNOWN);
    expect(autoLabel("", true)).toBe("auto (model not reported)");
  });
});
