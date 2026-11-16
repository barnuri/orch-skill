import { describe, expect, test } from "bun:test";

import { GRAPH_FOLLOW_KEY, GRAPH_HIDE_DONE_KEY } from "./constants";
import { DEFAULT_GRAPH_PREFS, loadGraphPrefs, saveGraphFollow, saveGraphHideDone } from "./graph-prefs";

function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem"> & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

const throwing: Pick<Storage, "getItem" | "setItem"> = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("quota");
  },
};

describe("graph prefs", () => {
  test("defaults when nothing is stored", () => {
    expect(loadGraphPrefs(memoryStorage())).toEqual(DEFAULT_GRAPH_PREFS);
    expect(DEFAULT_GRAPH_PREFS).toEqual({ follow: true, hideDone: false });
  });

  test("reads stored values", () => {
    const storage = memoryStorage({ [GRAPH_FOLLOW_KEY]: "0", [GRAPH_HIDE_DONE_KEY]: "1" });
    expect(loadGraphPrefs(storage)).toEqual({ follow: false, hideDone: true });
  });

  test("unknown values fall back field by field", () => {
    const storage = memoryStorage({ [GRAPH_FOLLOW_KEY]: "yes", [GRAPH_HIDE_DONE_KEY]: "1" });
    expect(loadGraphPrefs(storage)).toEqual({ follow: true, hideDone: true });
  });

  test("writes round-trip", () => {
    const storage = memoryStorage();
    saveGraphFollow(false, storage);
    saveGraphHideDone(true, storage);
    expect(storage.data.get(GRAPH_FOLLOW_KEY)).toBe("0");
    expect(storage.data.get(GRAPH_HIDE_DONE_KEY)).toBe("1");
    expect(loadGraphPrefs(storage)).toEqual({ follow: false, hideDone: true });
    saveGraphFollow(true, storage);
    expect(loadGraphPrefs(storage).follow).toBe(true);
  });

  test("storage errors and missing storage are swallowed", () => {
    expect(loadGraphPrefs(throwing)).toEqual(DEFAULT_GRAPH_PREFS);
    expect(loadGraphPrefs(null)).toEqual(DEFAULT_GRAPH_PREFS);
    expect(() => saveGraphFollow(false, throwing)).not.toThrow();
    expect(() => saveGraphHideDone(true, throwing)).not.toThrow();
    expect(() => saveGraphFollow(false, null)).not.toThrow();
  });
});
