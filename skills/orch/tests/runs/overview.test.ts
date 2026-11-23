import { test, expect } from "bun:test";
import { orch, seedHome, autoCleanup } from "../helpers";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { skillsInLog, githubSlug, pullsForCommit } from "../../core/commands/overview.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fakeBin } from "../helpers";
autoCleanup();

test("githubSlug reads owner/repo from ssh and https GitHub remotes only", () => {
  expect(githubSlug("git@github.com:acme/orch.git\n")).toBe("acme/orch");
  expect(githubSlug("https://github.com/acme/orch")).toBe("acme/orch");
  expect(githubSlug("https://gitlab.com/acme/orch.git")).toBe("");
  expect(githubSlug("")).toBe("");
});

test("pullsForCommit returns the PR URLs gh reports, and null when gh fails", () => {
  const repo = mkdtempSync(join(tmpdir(), "ov-repo-"));
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${fakeBin({ gh: "echo https://github.com/acme/orch/pull/7" })}:${oldPath}`;
    expect(pullsForCommit(repo, "acme/orch", "abc1234")).toEqual(["https://github.com/acme/orch/pull/7"]);
    process.env.PATH = `${fakeBin({ gh: "exit 1" })}:${oldPath}`;
    expect(pullsForCommit(repo, "acme/orch", "abc1234")).toBeNull();
  } finally {
    process.env.PATH = oldPath;
  }
});

test("run overview lists handoff evidence per node: present with size, or missing", () => {
  const home = seedHome();
  const o = orch(home, {});
  const R = o("run", "start", "handoff run").out.trim();
  o("node", "add", R, "a", "Node A");
  o("node", "add", R, "b", "Node B");
  mkdirSync(join(home, "runs", R, "out", "a"), { recursive: true });
  writeFileSync(join(home, "runs", R, "out", "a", "handoff.md"), "# done\n");
  expect(o("run", "overview", R).rc).toBe(0);
  const html = readFileSync(join(home, "runs", R, "overview.html"), "utf8");
  expect(html).toContain("<h2>Pull requests (per commit, GitHub repos)</h2>");
  expect(html).toContain("<h2>Handoff evidence</h2>");
  expect(html).toContain("yes (7 bytes)");
  expect(html).toContain("missing");
});

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
