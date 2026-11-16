import { test, expect, setDefaultTimeout } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tempDir, readJson, autoCleanup } from "../helpers";
import { ensureHome } from "../../core/state/profiles.ts";
setDefaultTimeout(120000);
autoCleanup();

const MARKERS = [".copilot-profile-migrated", ".copilot-planner-migrated", ".claude-planner-migrated", ".bench-local-migrated", ".claude-tiers-migrated", ".smart-auto-migrated"];

test("ensureHome on a fresh home seeds profiles and runs every migration once", async () => {
  const home = join(tempDir(), "h");
  expect(await ensureHome(home)).toBe(true);
  for (const m of MARKERS) expect(existsSync(join(home, m))).toBe(true);
  expect(existsSync(join(home, ".migrations/profiles-main"))).toBe(true);
  const before = MARKERS.map((m) => statSync(join(home, m)).mtimeMs);
  const profiles = statSync(join(home, "profiles.json")).mtimeMs;
  expect(await ensureHome(home)).toBe(true);
  expect(MARKERS.map((m) => statSync(join(home, m)).mtimeMs)).toEqual(before);
  expect(statSync(join(home, "profiles.json")).mtimeMs).toBe(profiles);
});

test("ensureHome migrates an old-format profiles.json", async () => {
  const home = join(tempDir(), "h");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "profiles.json"), JSON.stringify({
    models: { "claude-haiku": { description: "Fast and cheap: typos, formatting, tiny edits, boilerplate." } },
    profiles: { "claude-haiku": { harness: "claude", model: "claude-haiku", max_complexity: "trivial" }, "claude-default": { harness: "claude", priority: 8 } },
    settings: {},
  }));
  expect(await ensureHome(home)).toBe(true);
  for (const m of MARKERS) expect(existsSync(join(home, m))).toBe(true);
  const d = readJson(join(home, "profiles.json"));
  expect(d.profiles["claude-haiku"].max_complexity).not.toBe("trivial");
  expect(d.profiles["claude-default"].priority).toBe(9);
  expect(d.profiles["opencode-llm-hub"]).toBeDefined();
});
