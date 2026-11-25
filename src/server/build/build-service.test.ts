// test-tier: slow (real git repositories)
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BuildService, isTracked, readHeadSha } from "./build-service";

setDefaultTimeout(60_000);
const dirs: string[] = [];
const git = (cwd: string, ...args: string[]): string => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd });
  if (r.exitCode !== 0) {
    throw new Error(r.stderr.toString());
  }
  return r.stdout.toString().trim();
};

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "orch-build-"));
  dirs.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "skills/orch/scripts"), { recursive: true });
  writeFileSync(join(dir, "src/a.ts"), "a\n");
  writeFileSync(join(dir, "skills/orch/scripts/s.ts"), "s\n");
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
    const svc = new BuildService({ root: repo() });
    const r = await svc.refresh();
    expect(r.stale).toBe(false);
    expect(r.error).toBeNull();
    expect(r.reasons).toEqual([]);
    expect(r.head).toBe(svc.bootHead);
    expect(r.branch).not.toBeNull();
  });

  test("HEAD moved: commits reason, missing commits listed", async () => {
    const dir = repo();
    const svc = new BuildService({ root: dir });
    writeFileSync(join(dir, "README"), "x");
    git(dir, "add", "README");
    git(dir, "commit", "-q", "-m", "second one");
    const r = await svc.refresh();
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
    const svc = new BuildService({ root: dir });
    for (const f of ["src/node_modules/x/i.ts", "src/a.test.ts"]) {
      utimesSync(join(dir, f), future(), future());
    }
    expect((await svc.refresh()).stale).toBe(false);
    utimesSync(join(dir, "src/a.ts"), future(), future());
    const r = await svc.refresh();
    expect(r.stale).toBe(true);
    expect(r.reasons).toEqual(["files"]);
    expect(r.changed_files.count).toBe(1);
    expect(r.changed_files.newest[0]?.path).toBe("src/a.ts");
    expect(r.uncommitted.count).toBeGreaterThan(0);
  });

  test("both reasons, newest capped at 8", async () => {
    const dir = repo();
    const svc = new BuildService({ root: dir });
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(dir, `src/f${i}.ts`), "x");
      utimesSync(join(dir, `src/f${i}.ts`), future(), future());
    }
    utimesSync(join(dir, "skills/orch/scripts/s.ts"), future(), future());
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "more");
    const r = await svc.refresh();
    expect(r.reasons).toEqual(["commits", "files"]);
    expect(r.changed_files.count).toBe(11);
    expect(r.changed_files.newest).toHaveLength(8);
  });

  test("git missing: stale false with error text, never throws", async () => {
    const svc = new BuildService({ root: repo(), gitBin: "/nonexistent/git" });
    const r = await svc.refresh();
    expect(r.stale).toBe(false);
    expect(r.error).not.toBeNull();
  });

  test("timeout: stale false with a timeout error", async () => {
    const dir = repo();
    const slow = join(dir, "slow-git");
    writeFileSync(slow, "#!/bin/sh\nsleep 5\n");
    chmodSync(slow, 0o755);
    const svc = new BuildService({ root: dir, gitBin: slow, timeoutMs: 300 });
    const started = Date.now();
    const r = await svc.refresh();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r.stale).toBe(false);
    expect(r.error).toContain("timed out");
  });

  test("git probe timeout still reports head from the .git files (deploy health depends on it)", async () => {
    const dir = repo();
    const head = git(dir, "rev-parse", "HEAD");
    const slow = join(dir, "slow-git");
    writeFileSync(slow, "#!/bin/sh\nsleep 5\n");
    chmodSync(slow, 0o755);
    const svc = new BuildService({ root: dir, gitBin: slow, timeoutMs: 300 });
    const r = await svc.refresh();
    expect(r.error).toContain("timed out");
    expect(r.head).toBe(head);
    expect(r.boot_head).toBe(head);
  });

  test("readHeadSha: detached HEAD, branch ref, packed ref, and a non-repo", () => {
    const dir = repo();
    const head = git(dir, "rev-parse", "HEAD");
    expect(readHeadSha(dir)).toBe(head);
    git(dir, "checkout", "-q", "--detach", head);
    expect(readHeadSha(dir)).toBe(head);
    git(dir, "checkout", "-q", "-B", "feature");
    expect(readHeadSha(dir)).toBe(head);
    git(dir, "pack-refs", "--all");
    expect(readHeadSha(dir)).toBe(head);
    expect(readHeadSha(mkdtempSync(join(tmpdir(), "orch-nogit-")))).toBeNull();
  });

  test("concurrent refreshes share one run: the second is skipped", async () => {
    const dir = repo();
    const log = join(dir, "calls");
    const slow = join(dir, "slow-git");
    writeFileSync(slow, `#!/bin/sh\necho x >> ${log}\nsleep 0.3\nexec git "$@"\n`);
    chmodSync(slow, 0o755);
    const svc = new BuildService({ root: dir, gitBin: slow });
    const [a, b] = await Promise.all([svc.refresh(), svc.refresh()]);
    expect(a.branch).not.toBeNull();
    // One refresh runs branch + status (HEAD is read from the files); the skipped one spawns nothing.
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);
    expect(b.head).toBe(svc.bootHead);
  });

  test("timeout kills the git child and keeps the last good value", async () => {
    const dir = repo();
    const pidFile = join(dir, "pid");
    const flip = join(dir, "hang");
    const gitWrap = join(dir, "maybe-hang-git");
    writeFileSync(gitWrap, `#!/bin/sh\nif [ -f ${flip} ]; then echo $$ > ${pidFile}; exec sleep 30; fi\nexec git "$@"\n`);
    chmodSync(gitWrap, 0o755);
    const svc = new BuildService({ root: dir, gitBin: gitWrap, timeoutMs: 500 });
    const good = await svc.refresh();
    expect(good.error).toBeNull();
    writeFileSync(flip, "");
    const started = Date.now();
    const r = await svc.refresh();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r).toBe(good);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    await Bun.sleep(100);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("current() never runs git: boot HEAD before the first refresh, then the cached result", async () => {
    const dir = repo();
    const log = join(dir, "calls");
    const spy = join(dir, "spy-git");
    writeFileSync(spy, `#!/bin/sh\necho x >> ${log}\nexec git "$@"\n`);
    chmodSync(spy, 0o755);
    const svc = new BuildService({ root: dir, gitBin: spy });
    const quick = svc.current();
    expect(quick.head).toBe(svc.bootHead);
    expect(quick.branch).toBeNull();
    await Bun.sleep(50);
    expect(existsSync(log)).toBe(false);
    const full = await svc.refresh();
    expect(full.branch).not.toBeNull();
    const calls = readFileSync(log, "utf8");
    for (let i = 0; i < 100; i++) expect(svc.current()).toBe(full);
    await Bun.sleep(50);
    expect(readFileSync(log, "utf8")).toBe(calls);
  });

  test("git runs at nice 19", async () => {
    const dir = repo();
    const out = join(dir, "nice");
    const probe = join(dir, "probe-git");
    writeFileSync(probe, `#!/bin/sh\nps -o nice= -p $$ >> ${out}\nexec git "$@"\n`);
    chmodSync(probe, 0o755);
    await new BuildService({ root: dir, gitBin: probe }).refresh();
    expect(readFileSync(out, "utf8").trim().split(/\s+/)[0]).toBe("19");
  });

  test("deploy info comes from the refresh, not the request", async () => {
    const dir = repo();
    const home = mkdtempSync(join(tmpdir(), "orch-build-home-"));
    dirs.push(home);
    mkdirSync(join(home, "deploy"));
    const head = git(dir, "rev-parse", "HEAD");
    writeFileSync(join(home, "deploy/current.json"), JSON.stringify({ sha: head, ref: "master", deployed_at: "2026-01-01T00:00:00Z", tests: "ok" }));
    const svc = new BuildService({ root: dir, home });
    expect(svc.current().deploy).toBeNull();
    const r = await svc.refresh();
    expect(r.deploy?.short).toBe(head.slice(0, 7));
  });

  test("isTracked", () => {
    expect(isTracked("src/x/a.ts")).toBe(true);
    expect(isTracked("src/x/a.test.tsx")).toBe(false);
    expect(isTracked("src/node_modules/a.ts")).toBe(false);
  });
});
