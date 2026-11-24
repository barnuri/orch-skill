import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { commitsBehind, deployDir, lastFailure, readCurrent, readDeployInfo } from "./deploy-status";
import { deployWatchTick } from "./deploy-watch";
import { dispatchPath } from "../dispatch-path";

setDefaultTimeout(120_000);
const DEPLOY = resolve(import.meta.dir, "../../../scripts/deploy.ts");
const dirs: string[] = [];
const tmp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
const git = (cwd: string, ...a: string[]): string => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};

let repo: string;
let home: string;
let served = "";
let server: ReturnType<typeof Bun.serve>;
let fakeSvc: string;

function commit(file: string, msg: string): string {
  writeFileSync(join(repo, file), msg);
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", msg);
  return git(repo, "rev-parse", "HEAD");
}

beforeAll(() => {
  repo = tmp("deploy-repo-");
  home = tmp("deploy-home-");
  git(repo, "init", "-q", "-b", "master");
  server = Bun.serve({ port: 0, fetch: () => Response.json({ head: served }) });
  const state = tmp("deploy-svc-");
  fakeSvc = join(state, "service.ts");
  // The fake service "starts" the server at the sha of the root it is given, unless that root holds BADHEALTH.
  writeFileSync(
    fakeSvc,
    `import { existsSync, writeFileSync } from "node:fs";
const root = process.argv[process.argv.indexOf("--root") + 1];
const sha = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"]).stdout.toString().trim();
writeFileSync("${state}/served", existsSync(root + "/BADHEALTH") ? "bad" : sha);
writeFileSync("${state}/roots", root + "\\n", { flag: "a" });
`,
  );
  // Health answers whatever the fake service last wrote.
  server.stop(true);
  server = Bun.serve({ port: 0, fetch: () => Response.json({ head: existsSync(join(state, "served")) ? readFileSync(join(state, "served"), "utf8") : "" }) });
});

afterAll(() => {
  server.stop(true);
  Bun.spawnSync(["trash", ...dirs]);
});

async function deploy(env: Record<string, string> = {}, ...args: string[]): Promise<{ code: number; err: string; out: string }> {
  const p = Bun.spawn([process.execPath, DEPLOY, ...args], {
    env: {
      ...process.env,
      HARNESS_ORCH_HOME: home,
      ORCH_DEPLOY_REPO: repo,
      ORCH_SERVICE_SH: fakeSvc,
      ORCH_DEPLOY_HEALTH_URL: `http://127.0.0.1:${server.port}/api/build`,
      ORCH_DEPLOY_HEALTH_TIMEOUT_MS: "4000",
      ORCH_DEPLOY_TYPECHECK_CMD: "true",
      ORCH_DEPLOY_TEST_CMD: "test ! -f FAILTEST",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, err, out };
}

describe("deploy.ts", () => {
  let good = "";
  test("deploys master and records current.json", async () => {
    good = commit("a.txt", "one");
    const r = await deploy();
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(readCurrent(home)?.sha).toBe(good);
    expect(readCurrent(home)?.tests).toBe("passed");
    expect(readFileSync(join(deployDir(home), "history.jsonl"), "utf8")).toContain('"ok":true');
    expect(git(join(deployDir(home), "orch-skill"), "rev-parse", "HEAD")).toBe(good);
  });

  test("a test failure keeps the previous sha", async () => {
    commit("FAILTEST", "bad tests");
    const r = await deploy();
    expect(r.code).toBe(1);
    expect(r.err).toContain("tests failed");
    expect(readCurrent(home)?.sha).toBe(good);
    expect(git(join(deployDir(home), "orch-skill"), "rev-parse", "HEAD")).toBe(good);
    expect(lastFailure(home)).toContain("tests failed");
    expect(await commitsBehind(repo, good)).toBe(1);
    expect((await readDeployInfo(home, repo))?.failed).toContain("tests failed");
  });

  test("a health failure rolls back", async () => {
    git(repo, "rm", "-q", "FAILTEST");
    git(repo, "commit", "-q", "-m", "fix tests");
    commit("BADHEALTH", "bad health");
    const r = await deploy();
    expect(r.code).toBe(1);
    expect(r.err).toContain("rolled back to");
    expect(readCurrent(home)?.sha).toBe(good);
    expect(readFileSync(join(deployDir(home), "history.jsonl"), "utf8").trim().split("\n").pop()).toContain('"ok":false');
  }, 120_000);

  test("a live lock blocks a second deploy", async () => {
    const lock = join(deployDir(home), "lock.d");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), String(process.pid));
    const r = await deploy();
    expect(r.code).toBe(1);
    expect(r.err).toContain("another deploy is running");
    writeFileSync(join(lock, "pid"), "999999");
    const again = await deploy({}, "--dry-run");
    expect(again.code).toBe(0);
    Bun.spawnSync(["trash", lock]);
  });

  test("--dry-run prints the plan and changes nothing", async () => {
    const before = readCurrent(home)?.sha;
    const r = await deploy({}, "--dry-run");
    expect(r.out).toContain("service.ts restart --root");
    expect(readCurrent(home)?.sha).toBe(before);
  });

  test("watch starts a deploy only when master is past current.json", async () => {
    let n = 0;
    // master is the sha whose deploy just failed: not retried.
    expect(await deployWatchTick(home, () => void n++, repo)).toBe(false);
    commit("c.txt", "newer");
    expect(await deployWatchTick(home, () => void n++, repo)).toBe(true);
    expect(n).toBe(1);
    const empty = tmp("deploy-empty-");
    expect(await deployWatchTick(empty, () => void n++, repo)).toBe(false);
  });
});

describe("dispatch path", () => {
  test("resolves inside the root the server runs from", () => {
    delete process.env["ORCH_DISPATCH"];
    expect(dispatchPath()).toBe(resolve(import.meta.dir, "../../../skills/orch/scripts/dispatch.ts"));
  });
});
