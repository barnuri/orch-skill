import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * llm-hub deploy without a local build (D5: no cargo on this machine).
 * Takes the binary CI already built and attached to the release tag of the merged commit,
 * switches `<releases>/current`, hands the service port over to the new binary (`service handover`:
 * the new process passes healthz before the old one drains and exits, so no request fails),
 * rolls back when healthz fails, and records a cutover so `recordSavings` can measure
 * prompt-cache cost before and after.
 */

export type ReleaseCfg = { clone: string; releases: string; ref: string };
export type ExecResult = { code: number; out: string };
export type Exec = (cmd: string[], opts?: { cwd?: string }) => Promise<ExecResult>;

export const SAVINGS_HOURS = 24;

export const defaultExec: Exec = async (cmd, opts) => {
  const p = Bun.spawn(cmd, { cwd: opts?.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: (out + err).trim() };
};

/** Release asset name for this machine, as CI publishes it (`llm-hub-macos-aarch64`). */
export function assetName(platform: string = process.platform, arch: string = process.arch): string {
  const os = platform === "darwin" ? "macos" : platform === "linux" ? "linux" : platform;
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : arch;
  return `llm-hub-${os}-${cpu}`;
}

/** The release tag (`v0.1.136`) that points at `sha`, or null while CI has not published it. */
export async function releaseTag(clone: string, sha: string, exec: Exec = defaultExec): Promise<string | null> {
  await exec(["git", "-C", clone, "fetch", "-q", "--tags", "origin"]);
  const r = await exec(["git", "-C", clone, "tag", "--points-at", sha]);
  return r.out.split("\n").map((t) => t.trim()).find((t) => /^v\d/.test(t)) ?? null;
}

async function repoSlug(clone: string, exec: Exec): Promise<string | null> {
  const url = (await exec(["git", "-C", clone, "remote", "get-url", "origin"])).out;
  const slug = url.replace(/^.*[:/]([^/:]+\/[^/]+)$/, "$1").replace(/\.git$/, "");
  return slug.includes("/") ? slug : null;
}

function currentDir(releases: string): string | null {
  try {
    return realpathSync(join(releases, "current"));
  } catch {
    return null;
  }
}

function pointCurrent(releases: string, target: string): void {
  const tmp = join(releases, `.current-${process.pid}`);
  if (existsSync(tmp)) Bun.spawnSync(["trash", tmp]);
  symlinkSync(target, tmp);
  renameSync(tmp, join(releases, "current"));
}

export type ReleaseDeps = { exec?: Exec; gh?: string; healthUrl?: string; healthWaitS?: number; now?: () => number; sleep?: (ms: number) => Promise<void> };

/** Deploys the CI-built binary of `tag` as sha `sha`. Returns 0 on success, 1 on failure (current is restored). */
export async function deployRelease(cfg: ReleaseCfg, sha: string, tag: string, stateDir: string, logFile: string, deps: ReleaseDeps = {}): Promise<number> {
  const exec = deps.exec ?? defaultExec;
  const gh = deps.gh ?? (Bun.which("ghx") ? "ghx" : "gh");
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const healthUrl = deps.healthUrl ?? process.env["LLM_HUB_HEALTH_URL"] ?? "http://127.0.0.1:8888/healthz";
  const log = (m: string): void => appendFileSync(logFile, `release-deploy: ${m}\n`);
  const runDir = dirname(cfg.releases);
  const lock = join(cfg.releases, ".deploy.lock");

  mkdirSync(cfg.releases, { recursive: true });
  try {
    mkdirSync(lock);
  } catch {
    log(`another deploy holds ${lock}`);
    return 1;
  }
  const previous = currentDir(cfg.releases);
  const target = join(cfg.releases, sha);
  try {
    const slug = await repoSlug(cfg.clone, exec);
    if (slug === null) return (log("cannot read the origin slug"), 1);
    const dl = mkdtempSync(join(tmpdir(), "llmhub-release-"));
    const asset = assetName();
    const got = await exec([gh, "release", "download", tag, "-R", slug, "-p", asset, "-D", dl, "--clobber"]);
    if (got.code !== 0 || !existsSync(join(dl, asset))) return (log(`download of ${tag} ${asset} failed: ${got.out}`), 1);
    mkdirSync(target, { recursive: true });
    copyFileSync(join(dl, asset), join(target, "llm-hub"));
    chmodSync(join(target, "llm-hub"), 0o755);
    Bun.spawnSync(["trash", dl]);
    log(`downloaded ${tag} ${asset}, no local build`);

    pointCurrent(cfg.releases, target);
    const bin = join(cfg.releases, "current", "llm-hub");
    const healthy = async (): Promise<boolean> => (await exec(["curl", "-fsS", "-o", "/dev/null", "--max-time", "1", healthUrl])).code === 0;
    // A binary from before `service handover` prints the service usage and exits 1: restart it with `service install`.
    const switchService = async (): Promise<ExecResult> => {
      const handover = await exec([bin, "service", "handover"], { cwd: runDir });
      if (handover.code === 0 || !handover.out.includes("usage: llm-hub service")) return handover;
      log("this binary has no service handover, falling back to service install");
      return exec([bin, "service", "install"], { cwd: runDir });
    };
    const switchAndWait = async (): Promise<boolean> => {
      const sw = await switchService();
      if (sw.code !== 0) return (log(`service handover failed: ${sw.out}`), false);
      for (let i = 0; i < (deps.healthWaitS ?? 20); i++) {
        if (await healthy()) return true;
        await sleep(1000);
      }
      return false;
    };
    if (await switchAndWait()) {
      writeFileSync(join(stateDir, "cutover.json"), JSON.stringify({ sha, tag, previous: previous === null ? null : basename(previous), at_ms: now(), recorded: false }, null, 2));
      log(`deployed ${sha} (${tag}), healthz ok`);
      return 0;
    }
    log(`deploy of ${sha} failed health`);
    if (previous !== null && existsSync(previous)) {
      pointCurrent(cfg.releases, previous);
      // A failed handover leaves the old process serving; only a broken new process needs the previous binary back.
      if (await healthy()) log(`rolled back to ${basename(previous)}, the old process kept serving`);
      else {
        await switchService();
        log(`rolled back to ${basename(previous)}`);
      }
    }
    Bun.spawnSync(["trash", target]);
    return 1;
  } finally {
    rmdirSync(lock);
  }
}

export type Cutover = { sha: string; tag: string; previous: string | null; at_ms: number; recorded: boolean };

export function readCutover(stateDir: string): Cutover | null {
  try {
    return JSON.parse(readFileSync(join(stateDir, "cutover.json"), "utf8")) as Cutover;
  } catch {
    return null;
  }
}

export type SavingsResult = "none" | "waiting" | "recorded" | "failed";

/**
 * After a deploy, once `hours` of traffic exist after the cutover, runs the clone's
 * `scripts/cache-savings.mjs` (before vs after window of equal length) and writes
 * `savings-<sha>.json` plus a `savings-<sha>.md` table next to the cutover record.
 */
export async function recordSavings(cfg: ReleaseCfg, stateDir: string, deps: ReleaseDeps & { hours?: number } = {}): Promise<SavingsResult> {
  const cut = readCutover(stateDir);
  if (cut === null || cut.recorded) return "none";
  const hours = deps.hours ?? SAVINGS_HOURS;
  const now = (deps.now ?? Date.now)();
  if (now < cut.at_ms + hours * 3_600_000) return "waiting";
  const script = join(cfg.clone, "scripts/cache-savings.mjs");
  if (!existsSync(script)) return "failed";
  const exec = deps.exec ?? defaultExec;
  const args = [script, "--cutover", String(cut.at_ms), "--hours", String(hours), "--db", join(dirname(cfg.releases), "llm-hub.db")];
  const json = await exec(["node", ...args, "--json"], { cwd: cfg.clone });
  const md = await exec(["node", ...args], { cwd: cfg.clone });
  if (json.code !== 0 || md.code !== 0) {
    appendFileSync(join(stateDir, "deploy.log"), `savings: failed ${json.out || md.out}\n`);
    return "failed";
  }
  writeFileSync(join(stateDir, `savings-${cut.sha}.json`), json.out);
  writeFileSync(join(stateDir, `savings-${cut.sha}.md`), `${md.out}\n`);
  writeFileSync(join(stateDir, "cutover.json"), JSON.stringify({ ...cut, recorded: true }, null, 2));
  appendFileSync(join(stateDir, "deploy.log"), `savings: recorded for ${cut.sha}\n${md.out}\n`);
  return "recorded";
}
