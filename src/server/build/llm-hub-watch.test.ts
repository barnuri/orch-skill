import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { classifyChecks, deployedSha, llmHubConfig, llmHubWatchTick, type LlmHubConfig } from "./llm-hub-watch";

const dirs: string[] = [];
const tagOf = async (): Promise<string | null> => "v0.1.1";
setDefaultTimeout(120_000);
const tmp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
const git = (cwd: string, ...a: string[]): string => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd, stdin: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")} in ${cwd}: exit ${r.exitCode} ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

let origin: string;
let clone: string;
let releases: string;
let home: string;
let cfg: LlmHubConfig;
let sha0: string;
let sha1: string;

function commitAndPush(msg: string): string {
  writeFileSync(join(clone, "f.txt"), msg);
  git(clone, "add", ".");
  git(clone, "commit", "-q", "-m", msg);
  git(clone, "push", "-q", "origin", "HEAD:master");
  return git(clone, "rev-parse", "HEAD");
}

/** Points <releases>/current at a release dir for sha, as deploy-stable.sh does. */
function setCurrent(sha: string): void {
  mkdirSync(join(releases, sha), { recursive: true });
  const link = join(releases, "current");
  if (existsSync(link)) Bun.spawnSync(["trash", link]);
  symlinkSync(join(releases, sha), link);
}

beforeAll(() => {
  origin = tmp("llmhub-origin-");
  git(origin, "init", "-q", "--bare", "-b", "master");
  clone = tmp("llmhub-clone-");
  git(clone, "init", "-q", "-b", "master");
  git(clone, "remote", "add", "origin", origin);
  mkdirSync(join(clone, "scripts"), { recursive: true });
  writeFileSync(join(clone, "scripts/deploy-stable.sh"), "#!/bin/bash\n");
  sha0 = commitAndPush("base");
  releases = tmp("llmhub-releases-");
  home = tmp("llmhub-home-");
  setCurrent(sha0);
  cfg = { clone, releases, ref: "origin/master" };
  sha1 = commitAndPush("merged #55");
});

afterAll(() => {
  for (const d of dirs) Bun.spawnSync(["trash", d]);
});

describe("classifyChecks", () => {
  test("green only when every run is success, skipped or neutral", () => {
    expect(classifyChecks(["success", "skipped", "neutral"])).toBe("green");
    expect(classifyChecks(["success", "in_progress"])).toBe("pending");
    expect(classifyChecks(["queued"])).toBe("pending");
    expect(classifyChecks([])).toBe("pending");
    expect(classifyChecks(["success", "failure"])).toBe("failed");
    expect(classifyChecks(["cancelled"])).toBe("failed");
  });
});

describe("llmHubConfig", () => {
  test("requires an explicit opt-in before using the deploy clone", () => {
    const real = join(homedir(), ".harness-orch");
    expect(llmHubConfig(real, {})).toBeNull();
    expect(llmHubConfig(real, { ORCH_LLM_HUB_CLONE: "/x/clone" })).toBeNull();
    expect(llmHubConfig(real, { ORCH_LLM_HUB_WATCH: "1" })?.clone).toBe(join(homedir(), "sandbox/private/llm-hub-deploy"));
    expect(llmHubConfig(tmp("llmhub-gate-"), { ORCH_LLM_HUB_WATCH: "1", ORCH_LLM_HUB_CLONE: "/x/clone" })?.clone).toBe("/x/clone");
  });
});

describe("llmHubWatchTick", () => {
  test("is off without a release or without the deploy clone", async () => {
    const noClone = { ...cfg, clone: tmp("llmhub-none-") };
    expect(await llmHubWatchTick(home, noClone, async () => "green", async () => 0, tagOf)).toBe("off");
    const noRelease = { ...cfg, releases: tmp("llmhub-norel-") };
    expect(await llmHubWatchTick(home, noRelease, async () => "green", async () => 0, tagOf)).toBe("off");
  });

  test("does nothing while current is the head", async () => {
    setCurrent(sha1);
    let deploys = 0;
    expect(await llmHubWatchTick(home, cfg, async () => "green", async () => (deploys++, 0), tagOf)).toBe("current");
    expect(deploys).toBe(0);
    setCurrent(sha0);
  });

  test("waits while CI is pending, deploys when it turns green", async () => {
    let deploys = 0;
    const run = async (): Promise<number> => {
      deploys++;
      setCurrent(sha1);
      return 0;
    };
    expect(await llmHubWatchTick(home, cfg, async () => "pending", run, tagOf)).toBe("pending");
    expect(deploys).toBe(0);
    expect(await llmHubWatchTick(home, cfg, async () => "green", run, tagOf)).toBe("deployed");
    expect(deploys).toBe(1);
    expect(deployedSha(releases)).toBe(sha1);
    expect(readFileSync(join(home, "deploy/llm-hub/deploy.log"), "utf8")).toContain(`deploy ${sha1}`);
    expect(await llmHubWatchTick(home, cfg, async () => "green", run, tagOf)).toBe("current");
    setCurrent(sha0);
  });

  test("waits while CI has published no release tag, and runs no deploy", async () => {
    let deploys = 0;
    expect(await llmHubWatchTick(home, cfg, async () => "green", async () => (deploys++, 0), async () => null)).toBe("no-release");
    expect(deploys).toBe(0);
  });

  test("never runs a local build: the default deploy path has no cargo or deploy-stable.sh", () => {
    const src = readFileSync(join(import.meta.dir, "llm-hub-watch.ts"), "utf8") + readFileSync(join(import.meta.dir, "llm-hub-release.ts"), "utf8");
    expect(src).not.toMatch(/deploy-stable\.sh["`]/);
    expect(src).not.toMatch(/\[\s*"cargo"/);
  });

  test("a failed checks run is never deployed", async () => {
    let deploys = 0;
    expect(await llmHubWatchTick(home, cfg, async () => "failed", async () => (deploys++, 0), tagOf)).toBe("failed-checks");
    expect(deploys).toBe(0);
  });

  test("a failed deploy is not retried for the same sha, and current stays", async () => {
    let deploys = 0;
    const failing = async (): Promise<number> => (deploys++, 1);
    expect(await llmHubWatchTick(home, cfg, async () => "green", failing, tagOf)).toBe("deploy-failed");
    expect(await llmHubWatchTick(home, cfg, async () => "green", failing, tagOf)).toBe("failed-before");
    expect(deploys).toBe(1);
    expect(deployedSha(releases)).toBe(sha0);
  });

  test("a held deploy lock blocks the tick", async () => {
    mkdirSync(join(releases, ".deploy.lock"));
    expect(await llmHubWatchTick(tmp("llmhub-lock-"), cfg, async () => "green", async () => 0, tagOf)).toBe("busy");
    Bun.spawnSync(["trash", join(releases, ".deploy.lock")]);
  });
});
