import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assetName, deployRelease, readCutover, recordSavings, releaseTag, type Exec } from "./llm-hub-release";

const dirs: string[] = [];
const tmp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) Bun.spawnSync(["trash", d]);
});

/** Fake commands: records every call, `release download` writes the asset file, curl follows `healthy`. */
function fake(opts: { healthy?: boolean } = {}): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (cmd) => {
    calls.push(cmd);
    if (cmd[1] === "release") {
      writeFileSync(join(cmd[cmd.indexOf("-D") + 1] ?? "", cmd[cmd.indexOf("-p") + 1] ?? ""), "binary");
      return { code: 0, out: "" };
    }
    if (cmd[0] === "git" && cmd.includes("remote")) return { code: 0, out: "git@github.com:acme/llm-hub.git" };
    if (cmd[0] === "curl") return { code: opts.healthy === false ? 22 : 0, out: "" };
    return { code: 0, out: "" };
  };
  return { exec, calls };
}

function setup(): { cfg: { clone: string; releases: string; ref: string }; state: string; log: string; prev: string } {
  const root = tmp("llmhub-rel-");
  const releases = join(root, "releases");
  const prev = join(releases, "aaaa");
  mkdirSync(prev, { recursive: true });
  symlinkSync(prev, join(releases, "current"));
  const state = join(root, "state");
  mkdirSync(state);
  return { cfg: { clone: join(root, "clone"), releases, ref: "origin/master" }, state, log: join(state, "deploy.log"), prev };
}

describe("deployRelease (G16, D5)", () => {
  test("downloads the CI binary, switches current, installs the service, records a cutover, never calls cargo", async () => {
    const s = setup();
    const f = fake();
    const code = await deployRelease(s.cfg, "bbbb", "v0.1.9", s.state, s.log, { exec: f.exec, gh: "ghx", now: () => 1_000, sleep: async () => undefined });
    expect(code).toBe(0);
    expect(realpathSync(join(s.cfg.releases, "current"))).toBe(realpathSync(join(s.cfg.releases, "bbbb")));
    expect(readFileSync(join(s.cfg.releases, "bbbb/llm-hub"), "utf8")).toBe("binary");
    const dl = f.calls.find((c) => c[1] === "release");
    expect(dl?.slice(0, 7)).toEqual(["ghx", "release", "download", "v0.1.9", "-R", "acme/llm-hub", "-p"]);
    expect(dl?.[7]).toBe(assetName());
    expect(f.calls.some((c) => c[1] === "service" && c[2] === "install")).toBe(true);
    expect(f.calls.flat().some((a) => /cargo|deploy-stable/.test(a))).toBe(false);
    expect(readCutover(s.state)).toEqual({ sha: "bbbb", tag: "v0.1.9", previous: "aaaa", at_ms: 1_000, recorded: false });
    expect(existsSync(join(s.cfg.releases, ".deploy.lock"))).toBe(false);
  });

  test("rolls back to the previous release when healthz never answers", async () => {
    const s = setup();
    const f = fake({ healthy: false });
    const code = await deployRelease(s.cfg, "bbbb", "v0.1.9", s.state, s.log, { exec: f.exec, gh: "ghx", healthWaitS: 2, sleep: async () => undefined });
    expect(code).toBe(1);
    expect(realpathSync(join(s.cfg.releases, "current"))).toBe(realpathSync(s.prev));
    expect(readCutover(s.state)).toBeNull();
    expect(readFileSync(s.log, "utf8")).toContain("rolled back to aaaa");
  });
});

describe("releaseTag", () => {
  test("takes the first v-tag that points at the sha, null when CI has not tagged it", async () => {
    const exec: Exec = async (cmd) => ({ code: 0, out: cmd.includes("tag") ? "junk\nv0.1.9" : "" });
    expect(await releaseTag("/c", "sha", exec)).toBe("v0.1.9");
    expect(await releaseTag("/c", "sha", async () => ({ code: 0, out: "" }))).toBeNull();
  });
});

describe("recordSavings (G13 before/after)", () => {
  test("waits until the after window has passed, then writes the report once", async () => {
    const s = setup();
    mkdirSync(join(s.cfg.clone, "scripts"), { recursive: true });
    writeFileSync(join(s.cfg.clone, "scripts/cache-savings.mjs"), "");
    writeFileSync(join(s.state, "cutover.json"), JSON.stringify({ sha: "bbbb", tag: "v0.1.9", previous: "aaaa", at_ms: 0, recorded: false }));
    const calls: string[][] = [];
    const exec: Exec = async (cmd) => {
      calls.push(cmd);
      return { code: 0, out: cmd.includes("--json") ? '{"saved_usd_per_1k_requests":1.5}' : "Saved: $1.50 per 1k requests" };
    };
    expect(await recordSavings(s.cfg, s.state, { exec, hours: 24, now: () => 3_600_000 })).toBe("waiting");
    expect(calls.length).toBe(0);
    expect(await recordSavings(s.cfg, s.state, { exec, hours: 24, now: () => 24 * 3_600_000 })).toBe("recorded");
    expect(calls[0]?.slice(0, 3)).toEqual(["node", join(s.cfg.clone, "scripts/cache-savings.mjs"), "--cutover"]);
    expect(calls[0]).toContain(join(s.cfg.releases, "../llm-hub.db").replace(/\/releases\/\.\.\//, "/"));
    expect(JSON.parse(readFileSync(join(s.state, "savings-bbbb.json"), "utf8")).saved_usd_per_1k_requests).toBe(1.5);
    expect(readFileSync(join(s.state, "savings-bbbb.md"), "utf8")).toContain("Saved: $1.50");
    expect(readCutover(s.state)?.recorded).toBe(true);
    expect(await recordSavings(s.cfg, s.state, { exec, now: () => 99 * 3_600_000 })).toBe("none");
  });
});
