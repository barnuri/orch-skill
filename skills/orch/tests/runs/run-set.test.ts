import { test, expect } from "bun:test";
import { join } from "node:path";
import { dispatch, seedHome, readJson, autoCleanup } from "../helpers";
autoCleanup();

test("run set auto_dispatch", () => {
  const home = seedHome();
  const state = () => readJson(join(home, "runs/set-1/state.json"));
  dispatch(home, "run", "start", "Set test", "--id", "set-1");
  expect(state().auto_dispatch ?? null).toBeNull();
  const r = dispatch(home, "run", "set", "set-1", "auto_dispatch", "true");
  expect(r.rc).toBe(0);
  expect(r.out).toMatch(/^auto_dispatch: set-1 true$/m);
  expect(state().auto_dispatch).toBe(true);
  dispatch(home, "run", "set", "set-1", "auto_dispatch", "false");
  expect(state().auto_dispatch).toBe(false);
  expect(dispatch(home, "run", "set", "set-1", "auto_dispatch", "maybe").rc).toBe(2);
  expect(dispatch(home, "run", "set", "set-1", "colour", "blue").rc).toBe(2);
  expect(dispatch(home, "run", "set", "no-such-run", "auto_dispatch", "true").rc).not.toBe(0);
});
