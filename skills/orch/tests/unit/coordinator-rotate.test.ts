import { test, expect } from "bun:test";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { DISPATCH, seedHome, runCmd, editJson, autoCleanup } from "../helpers";
import { COORDINATOR_MODEL_DEFAULT, COORDINATOR_ROTATE_TOKENS_DEFAULT, coordinatorArgv, coordinatorPrompt, coordinatorSettingsFrom, needsRotation } from "../../core/commands/coordinator.ts";
autoCleanup();

test("coordinator settings: defaults and overrides", () => {
  expect(coordinatorSettingsFrom({})).toEqual({ model: "llm-hub/copilot/claude-sonnet-5-5", rotateTokens: 200000 });
  expect(COORDINATOR_MODEL_DEFAULT).toBe("llm-hub/copilot/claude-sonnet-5-5");
  expect(COORDINATOR_ROTATE_TOKENS_DEFAULT).toBe(200000);
  expect(coordinatorSettingsFrom({ settings: { coordinator_model: "x/y", coordinator_rotate_tokens: 5000 } })).toEqual({ model: "x/y", rotateTokens: 5000 });
  expect(coordinatorSettingsFrom({ settings: { coordinator_rotate_tokens: "bad" } }).rotateTokens).toBe(200000);
  expect(needsRotation(199999, 200000)).toBe(false);
  expect(needsRotation(200000, 200000)).toBe(true);
});

test("coordinator prompt forbids tests and foreground subagents, argv pins the model", () => {
  const p = coordinatorPrompt("r1", "/h.md");
  expect(p).toMatch(/never start foreground subagents/);
  expect(p).toMatch(/Do not run tests/);
  expect(p).toMatch(/\/h\.md/);
  expect(coordinatorArgv("m/x", "go")).toEqual(["opencode", "--model", "m/x", "--prompt", "go"]);
});

test("coordinator rotate: below threshold no-op, above writes a handoff and starts with the setting model", () => {
  const home = seedHome();
  const o = (...a: string[]) => runCmd([process.execPath, DISPATCH, ...a], { home, env: { ORCH_OWNER_FILL: "0" } });
  const R = o("run", "start", "rotate run").out.trim();
  o("node", "add", R, "a", "Node A");
  editJson(join(home, "profiles.json"), (d) => { d.settings = { ...(d.settings ?? {}), coordinator_model: "llm-hub/test-model", coordinator_rotate_tokens: 1000 }; });

  const low = o("coordinator", "rotate", R, "--tokens", "999", "--dry-run");
  expect(low.rc).toBe(0);
  expect(low.out).toMatch(/^ok: 999 < 1000/);

  const hi = o("coordinator", "rotate", R, "--tokens", "1500", "--summary", "did X", "--dry-run");
  expect(hi.rc).toBe(0);
  const dir = join(home, "runs", R, "coordinator-handoffs");
  const files = readdirSync(dir);
  expect(files.length).toBe(1);
  const body = readFileSync(join(dir, files[0]!), "utf8");
  expect(body).toMatch(/did X/);
  expect(body).toMatch(/- a: \w+ — Node A/);
  const argv = JSON.parse(hi.out.split("\n").find((l) => l.startsWith("["))!);
  expect(argv.slice(0, 3)).toEqual(["opencode", "--model", "llm-hub/test-model"]);
  expect(argv[4]).toContain(join(dir, files[0]!));

  expect(o("coordinator", "rotate", R).rc).toBe(2);
  expect(o("coordinator", "start", "no-such-run", "--dry-run").rc).toBe(1);
});
