// Runtime proof that neither lane reads or writes the live orch home.
// Each test gives the lane a sandbox HOME holding a `.harness-orch` sentinel:
//  - the sentinel file is mode 000, so any read of its contents fails with EACCES (logged by the process);
//  - the sentinel tree fingerprint (names, sizes, mtimes) must not change, so no write, create or delete lands there.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertLanePort, fingerprint, freePort, seedLaneHome, LIVE_PORT } from "../../integration/lib.ts";

const uiRoot = join(import.meta.dir, "../..");
let root = "";
let sandboxHome = "";
let sentinel = "";
let sentinelFile = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "orch-proof-"));
  sandboxHome = join(root, "home");
  sentinel = join(sandboxHome, ".harness-orch");
  sentinelFile = join(sentinel, "sentinel.txt");
  mkdirSync(sentinel, { recursive: true });
  writeFileSync(sentinelFile, "must not be read or changed\n");
  chmodSync(sentinelFile, 0o000);
});

afterAll(() => {
  if (sentinelFile && existsSync(sentinelFile)) chmodSync(sentinelFile, 0o600);
  if (root) rmSync(root, { recursive: true, force: true });
});

async function waitFor(url: string, timeoutMs = 60_000): Promise<Response> {
  const started = Date.now();
  for (;;) {
    try {
      return await fetch(url);
    } catch (e) {
      if (Date.now() - started > timeoutMs) throw e;
      await Bun.sleep(300);
    }
  }
}

test("mock lane serves fixtures without reading or writing the sentinel home", async () => {
  const port = assertLanePort(await freePort());
  const before = fingerprint(sentinel);
  const proc = Bun.spawn(["bun", "mock/serve.ts"], {
    cwd: uiRoot,
    env: { PATH: process.env.PATH ?? "", HOME: sandboxHome, HARNESS_ORCH_HOME: sentinel, ORCH_MOCK_PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const runs = await waitFor(`http://127.0.0.1:${port}/api/runs`);
    expect(runs.status).toBe(200);
    expect(await runs.text()).toContain("20261120-090000-a1b2");
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).text();
    expect(health).toContain("/mock/orch-home");
    expect(health).not.toContain(".harness-orch");
  } finally {
    proc.kill();
    await proc.exited;
  }
  const stderr = await new Response(proc.stderr).text();
  expect(stderr).not.toMatch(/EACCES|ENOENT.*harness-orch/);
  expect(stderr).not.toContain(String(LIVE_PORT));
  expect(fingerprint(sentinel)).toBe(before);
}, 120_000);

test("lane seed writes only under the lane home", async () => {
  const home = join(root, "lane-home");
  const before = fingerprint(sentinel);
  await seedLaneHome(home, sandboxHome);
  expect(existsSync(join(home, "runs", "lane-run", "state.json"))).toBe(true);
  expect(fingerprint(sentinel)).toBe(before);
  expect(home.startsWith(sandboxHome)).toBe(false);
}, 120_000);

test("lane port guard refuses the live port and out-of-range values", () => {
  expect(() => assertLanePort(LIVE_PORT)).toThrow(/6724/);
  expect(() => assertLanePort(0)).toThrow();
  expect(() => assertLanePort(70000)).toThrow();
  expect(assertLanePort(16724)).toBe(16724);
});

test("compose config binds only the lane home and the random port", async () => {
  const port = await freePort();
  const home = join(root, "bind-home");
  mkdirSync(home, { recursive: true });
  const proc = Bun.spawn(
    ["docker", "compose", "-f", join(uiRoot, "integration/docker-compose.yml"), "config", "--format", "json"],
    // The real HOME stays: the docker CLI finds its compose plugin there. Nothing in `config` reads the orch home.
    { env: { ...process.env, ORCH_LANE_PORT: String(port), ORCH_LANE_HOME: home }, stdout: "pipe", stderr: "pipe" },
  );
  const text = await new Response(proc.stdout).text();
  expect(await proc.exited, await new Response(proc.stderr).text()).toBe(0);
  const svc = JSON.parse(text).services.orch;
  const sources: string[] = svc.volumes.map((v: { source?: string }) => v.source ?? "");
  expect(sources).toContain(home);
  for (const src of sources) expect(src).not.toContain(".harness-orch");
  const published = svc.ports.map((p: { published: string; target: number; host_ip?: string }) => p);
  expect(published.some((p: { published: string; target: number }) => p.published === String(port) && p.target === 6724)).toBe(true);
  expect(published.some((p: { published: string }) => p.published === String(LIVE_PORT))).toBe(false);
  expect(svc.environment.HARNESS_ORCH_HOME).toBe("/orch-home");
}, 120_000);
