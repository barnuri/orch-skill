import { describe, expect, test } from "bun:test";

import { GRAPH_ACTIVITY_EXPANDED_KEY, GRAPH_FOLLOW_KEY, GRAPH_HIDE_DONE_KEY, GRAPH_MODE_KEY, GRAPH_SCALE_KEY, ZOOM_MAX, ZOOM_MIN } from "./constants";
import {
  DEFAULT_GRAPH_PREFS,
  clampZoom,
  loadGraphPrefs,
  saveGraphActivityExpanded,
  saveGraphFollow,
  saveGraphHideDone,
  saveGraphMode,
  saveGraphScale,
  saveGraphNodeView,
} from "./graph-prefs";

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
    expect(DEFAULT_GRAPH_PREFS).toEqual({ follow: true, hideDone: false, scale: 1, mode: "fit", activityExpanded: false, nodeView: null });
  });

  test("reads stored values", () => {
    const storage = memoryStorage({ [GRAPH_FOLLOW_KEY]: "0", [GRAPH_HIDE_DONE_KEY]: "1" });
    expect(loadGraphPrefs(storage)).toEqual({ follow: false, hideDone: true, scale: 1, mode: "fit", activityExpanded: false, nodeView: null });
  });

  test("unknown values fall back field by field", () => {
    const storage = memoryStorage({ [GRAPH_FOLLOW_KEY]: "yes", [GRAPH_HIDE_DONE_KEY]: "1" });
    expect(loadGraphPrefs(storage)).toEqual({ follow: true, hideDone: true, scale: 1, mode: "fit", activityExpanded: false, nodeView: null });
  });

  test("writes round-trip", () => {
    const storage = memoryStorage();
    saveGraphFollow(false, storage);
    saveGraphHideDone(true, storage);
    expect(storage.data.get(GRAPH_FOLLOW_KEY)).toBe("0");
    expect(storage.data.get(GRAPH_HIDE_DONE_KEY)).toBe("1");
    expect(loadGraphPrefs(storage)).toEqual({ follow: false, hideDone: true, scale: 1, mode: "fit", activityExpanded: false, nodeView: null });
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

  test("zoom scale round-trips and is clamped on read and write", () => {
    const storage = memoryStorage();
    saveGraphScale(1.5, storage);
    expect(storage.data.get(GRAPH_SCALE_KEY)).toBe("1.5");
    expect(loadGraphPrefs(storage).scale).toBe(1.5);
    saveGraphScale(99, storage);
    expect(loadGraphPrefs(storage).scale).toBe(ZOOM_MAX);
    saveGraphScale(0.001, storage);
    expect(loadGraphPrefs(storage).scale).toBe(ZOOM_MIN);
    expect(clampZoom(-3)).toBe(ZOOM_MIN);
  });

  test("corrupt scale values fall back to the default", () => {
    for (const raw of ["", "  ", "abc", "NaN", "Infinity", "1.5x"]) {
      expect(loadGraphPrefs(memoryStorage({ [GRAPH_SCALE_KEY]: raw })).scale).toBe(1);
    }
    expect(loadGraphPrefs(memoryStorage({ [GRAPH_SCALE_KEY]: "Infinity" })).scale).toBe(1);
    expect(loadGraphPrefs(memoryStorage({ [GRAPH_SCALE_KEY]: "-Infinity" })).scale).toBe(1);
  });

  test("non-finite scale writes are ignored", () => {
    const storage = memoryStorage();
    saveGraphScale(Number.NaN, storage);
    expect(storage.data.has(GRAPH_SCALE_KEY)).toBe(false);
  });

  test("view mode round-trips and unknown values fall back to fit", () => {
    const storage = memoryStorage();
    saveGraphMode("original", storage);
    expect(loadGraphPrefs(storage).mode).toBe("original");
    saveGraphMode("manual", storage);
    expect(loadGraphPrefs(storage).mode).toBe("manual");
    storage.data.set(GRAPH_MODE_KEY, "zoomed");
    expect(loadGraphPrefs(storage).mode).toBe("fit");
    saveGraphMode("bogus" as "fit", storage);
    expect(storage.data.get(GRAPH_MODE_KEY)).toBe("zoomed");
  });

  test("activity expanded round-trips with the same flag pattern", () => {
    const storage = memoryStorage();
    saveGraphActivityExpanded(true, storage);
    expect(storage.data.get(GRAPH_ACTIVITY_EXPANDED_KEY)).toBe("1");
    expect(loadGraphPrefs(storage).activityExpanded).toBe(true);
    expect(loadGraphPrefs(memoryStorage({ [GRAPH_ACTIVITY_EXPANDED_KEY]: "maybe" })).activityExpanded).toBe(false);
  });

  test("new writers swallow storage errors and missing storage", () => {
    expect(() => saveGraphScale(2, throwing)).not.toThrow();
    expect(() => saveGraphMode("manual", throwing)).not.toThrow();
    expect(() => saveGraphActivityExpanded(true, throwing)).not.toThrow();
    expect(() => saveGraphScale(2, null)).not.toThrow();
    expect(() => saveGraphMode("manual", null)).not.toThrow();
    expect(() => saveGraphActivityExpanded(true, null)).not.toThrow();
    expect(loadGraphPrefs(throwing)).toEqual(DEFAULT_GRAPH_PREFS);
  });
});

describe("node view pref", () => {
  test("saves chat or output globally and ignores other values", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(loadGraphPrefs(storage).nodeView).toBeNull();
    saveGraphNodeView("output", storage);
    expect(loadGraphPrefs(storage).nodeView).toBe("output");
    store.set("orch.graph.nodeView", "bogus");
    expect(loadGraphPrefs(storage).nodeView).toBeNull();
  });
});
