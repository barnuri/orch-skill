// test-tier: slow (real git repositories)
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BuildService, isTracked } from "./build-service";

setDefaultTimeout(60_000);
const dirs: string[] = [];
const git = (cwd: string, ...args: string[]): void => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd });
  if (r.exitCode !== 0) {
    throw new Error(r.stderr.toString());
  }
};

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "orch-build-"));
  dirs.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "skills/orch/scripts"), { recursive: true });
  writeFileSync(join(dir, "src/a.ts"), "a\n");
  writeFileSync(join(dir, "skills/orch/scripts/s.sh"), "s\n");
  git(dir, "init", "-q");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}

afterAll(() => {
  Bun.spawnSync(["trash", ...dirs]);
}, 60_000);

const future = (): Date => new Date(Date.now() + 60_000);

describe("BuildService", () => {
  test("neither: not stale", async () => {
    const svc = new BuildService({ root: repo(), cacheMs: 0 });
    const r = await svc.check();
    expect(r.stale).toBe(false);
    expect(r.error).toBeNull();
    expect(r.reasons).toEqual([]);
    expect(r.head).toBe(svc.bootHead);
    expect(r.branch).not.toBeNull();
  });

  test("HEAD moved: commits reason, missing commits listed", async () => {
    const dir = repo();
    const svc = new BuildService({ root: dir, cacheMs: 0 });
    writeFileSync(join(dir, "README"), "x");
    git(dir, "add", "README");
    git(dir, "commit", "-q", "-m", "second one");
    const r = await svc.check();
    expect(r.stale).toBe(true);
    expect(r.reasons).toEqual(["commits"]);
    expect(r.missing_total).toBe(1);
    expect(r.missing_commits[0]?.subject).toBe("second one");
    expect(r.missing_commits[0]?.sha).toHaveLength(40);
    expect(r.head).not.toBe(r.boot_head);
  });

  test("file touched after boot: files reason, test files and node_modules ignored", async () => {
    const dir = repo();
    mkdirSync(join(dir, "src/node_modules/x"), { recursive: true });
    writeFileSync(join(dir, "src/node_modules/x/i.ts"), "i");
    writeFileSync(join(dir, "src/a.test.ts"), "t");
    const svc = new BuildService({ root: dir, cacheMs: 0 });
    for (const f of ["src/node_modules/x/i.ts", "src/a.test.ts"]) {
      utimesSync(join(dir, f), future(), future());
    }
    expect((await svc.check()).stale).toBe(false);
    utimesSync(join(dir, "src/a.ts"), future(), future());
    const r = await svc.check();
    expect(r.stale).toBe(true);
    expect(r.reasons).toEqual(["files"]);
    expect(r.changed_files.count).toBe(1);
    expect(r.changed_files.newest[0]?.path).toBe("src/a.ts");
    expect(r.uncommitted.count).toBeGreaterThan(0);
  });

  test("both reasons, newest capped at 8", async () => {
    const dir = repo();
    const svc = new BuildService({ root: dir, cacheMs: 0 });
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(dir, `src/f${i}.ts`), "x");
      utimesSync(join(dir, `src/f${i}.ts`), future(), future());
    }
    utimesSync(join(dir, "skills/orch/scripts/s.sh"), future(), future());
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "more");
    const r = await svc.check();
    expect(r.reasons).toEqual(["commits", "files"]);
    expect(r.changed_files.count).toBe(11);
    expect(r.changed_files.newest).toHaveLength(8);
  });

  test("git missing: stale false with error text, never throws", async () => {
    const svc = new BuildService({ root: repo(), cacheMs: 0, gitBin: "/nonexistent/git" });
    const r = await svc.check();
    expect(r.stale).toBe(false);
    expect(r.error).not.toBeNull();
  });

  test("timeout: stale false with a timeout error", async () => {
    const dir = repo();
    const slow = join(dir, "slow-git");
    writeFileSync(slow, "#!/bin/sh\nsleep 5\n");
    chmodSync(slow, 0o755);
    const svc = new BuildService({ root: dir, cacheMs: 0, gitBin: slow, timeoutMs: 300 });
    const started = Date.now();
    const r = await svc.check();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r.stale).toBe(false);
    expect(r.error).toContain("timed out");
  });

  test("results are cached and concurrent callers share one run", async () => {
    const svc = new BuildService({ root: repo(), cacheMs: 60_000 });
    const [a, b] = await Promise.all([svc.check(), svc.check()]);
    expect(a).toBe(b);
    expect(await svc.check()).toBe(a);
  });

  test("isTracked", () => {
    expect(isTracked("src/x/a.ts")).toBe(true);
    expect(isTracked("src/x/a.test.tsx")).toBe(false);
    expect(isTracked("src/node_modules/a.ts")).toBe(false);
  });
});
