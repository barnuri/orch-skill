import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { DeployInfo } from "../../shared/types/build-info";

export const deployDir = (home: string): string => join(home, "deploy");
export const deployCheckout = (home: string): string => join(deployDir(home), "orch-skill");

export interface DeployCurrent {
  sha: string;
  ref: string;
  deployed_at: string;
  tests: string;
}

export function readCurrent(home: string): DeployCurrent | null {
  try {
    const v = JSON.parse(readFileSync(join(deployDir(home), "current.json"), "utf8")) as DeployCurrent;
    return typeof v.sha === "string" && v.sha !== "" ? v : null;
  } catch {
    return null;
  }
}

/** The reason of the last history entry when it is a failed deploy, else null. */
export function lastFailure(home: string): string | null {
  try {
    const lines = readFileSync(join(deployDir(home), "history.jsonl"), "utf8").split("\n").filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1] ?? "null") as { ok?: boolean; reason?: string } | null;
    return last !== null && last.ok === false ? (last.reason ?? "unknown") : null;
  } catch {
    return null;
  }
}

async function gitOut(root: string, args: string[]): Promise<string | null> {
  try {
    const p = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    return (await p.exited) === 0 ? out.trim() : null;
  } catch {
    return null;
  }
}

/** Commits master has past the deployed sha; null when master or the sha is unknown. */
export async function commitsBehind(root: string, sha: string, ref = "master"): Promise<number | null> {
  const n = await gitOut(root, ["rev-list", "--count", `${sha}..${ref}`]);
  return n !== null && /^\d+$/.test(n) ? Number(n) : null;
}

export async function readDeployInfo(home: string, root: string): Promise<DeployInfo | null> {
  const cur = readCurrent(home);
  const failed = lastFailure(home);
  if (cur === null && failed === null) {
    return null;
  }
  return {
    sha: cur?.sha ?? null,
    short: cur === null ? null : cur.sha.slice(0, 7),
    ref: cur?.ref ?? null,
    deployed_at: cur?.deployed_at ?? null,
    behind: cur === null ? null : await commitsBehind(root, cur.sha),
    failed,
  };
}

export const hasDeploy = (home: string): boolean => existsSync(join(deployDir(home), "current.json"));

