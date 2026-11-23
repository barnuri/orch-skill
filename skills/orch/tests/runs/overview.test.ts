import { test, expect } from "bun:test";
import { orch, seedHome, autoCleanup } from "../helpers";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { skillsInLog } from "../../core/commands/overview.ts";
autoCleanup();

test("skillsInLog finds skill names read from SKILL.md paths", () => {
  const log = "→ Read /x/skills/code-gen/SKILL.md [offset=1]\n→ Read /y/skills/dev-guidelines/SKILL.md\n→ Read /x/skills/code-gen/SKILL.md";
  expect(skillsInLog(log)).toEqual(["code-gen", "dev-guidelines"]);
});

test("run start --description stores it and run overview renders it", () => {
  const home = seedHome();
  const o = orch(home, {});
  const R = o("run", "start", "described run", "--description", "Ships the watchdog").out.trim();
  const st = JSON.parse(readFileSync(join(home, "runs", R, "state.json"), "utf8"));
  expect(st.description).toBe("Ships the watchdog");
  expect(o("run", "overview", R).rc).toBe(0);
  const html = readFileSync(join(home, "runs", R, "overview.html"), "utf8");
  expect(html).toContain("Ships the watchdog");
  expect(html).toContain("<h2>Models</h2>");
});

test("run describe sets the description after start", () => {
  const home = seedHome();
  const o = orch(home, {});
  const R = o("run", "start", "later").out.trim();
  expect(o("run", "describe", R, "Added later").rc).toBe(0);
  const st = JSON.parse(readFileSync(join(home, "runs", R, "state.json"), "utf8"));
  expect(st.description).toBe("Added later");
});
