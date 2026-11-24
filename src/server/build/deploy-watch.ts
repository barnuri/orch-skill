import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { commitsBehind, deployDir, hasDeploy, readCurrent } from "./deploy-status";
import { REPO_ROOT } from "./restart";

export const DEPLOY_WATCH_MS: number = 2 * 60_000;

export type SpawnDeploy = () => void;

const defaultSpawn: SpawnDeploy = () => {
  const home = process.env["HARNESS_ORCH_HOME"] ?? "";
  const p = Bun.spawn([process.execPath, join(REPO_ROOT, "scripts/deploy.ts")], { stdout: "ignore", stderr: "ignore", env: { ...process.env, ...(home ? { HARNESS_ORCH_HOME: home } : {}) } });
  p.unref();
};

/** The sha of the last failed deploy, so a broken master is not redeployed every 5 minutes. */
function lastFailedSha(home: string): string | null {
  try {
    const lines = readFileSync(join(deployDir(home), "history.jsonl"), "utf8").split("\n").filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1] ?? "null") as { ok?: boolean; sha?: string | null } | null;
    return last && last.ok === false ? (last.sha ?? null) : null;
  } catch {
    return null;
  }
}

async function gitRun(root: string, args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(p.stdout).text()).trim();
  return { code: await p.exited, out };
}

/** The ref the service follows: origin/master after a fetch (GitHub checks gate it), or master when there is no origin. */
export async function deployRef(root: string): Promise<string> {
  if ((await gitRun(root, ["remote", "get-url", "origin"])).code !== 0) return "master";
  await gitRun(root, ["fetch", "-q", "origin"]);
  return "origin/master";
}

async function masterSha(root: string, ref: string): Promise<string | null> {
  const p = Bun.spawn(["git", "-C", root, "rev-parse", ref], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(p.stdout).text()).trim();
  return (await p.exited) === 0 && out !== "" ? out : null;
}

/** One check: start a deploy when the followed ref (origin/master, else master) is past current.json; deploy.ts waits for its GitHub checks. Only acts once a deploy has happened on this home. */
export async function deployWatchTick(home: string, spawn: SpawnDeploy = defaultSpawn, root: string = REPO_ROOT): Promise<boolean> {
  if (!hasDeploy(home) || existsSync(join(deployDir(home), "lock.d"))) return false;
  const cur = readCurrent(home);
  if (cur === null) return false;
  const ref = await deployRef(root);
  const behind = await commitsBehind(root, cur.sha, ref);
  if (behind === null || behind === 0) return false;
  const head = await masterSha(root, ref);
  if (head !== null && head === lastFailedSha(home)) return false;
  spawn();
  return true;
}

export function startDeployWatch(home: string, everyMs: number = DEPLOY_WATCH_MS, spawn?: SpawnDeploy): () => void {
  const t = setInterval(() => void deployWatchTick(home, spawn).catch(() => false), everyMs);
  t.unref?.();
  return () => clearInterval(t);
}
