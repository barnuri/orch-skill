import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { deployDir } from "./deploy-status";

/** Watches llm-hub: when origin/master in the dedicated deploy clone is past `<releases>/current` and its GitHub checks are green, runs the clone's `scripts/deploy-stable.sh`. */

export const LLM_HUB_WATCH_MS: number = 2 * 60_000;

export type LlmHubConfig = { clone: string; releases: string; ref: string };
export type ChecksState = "green" | "pending" | "failed" | "unknown";
export type ReadChecks = (clone: string, sha: string) => Promise<ChecksState>;
export type RunDeploy = (cfg: LlmHubConfig, logFile: string) => Promise<number>;
export type TickResult = "off" | "current" | "busy" | "pending" | "failed-checks" | "failed-before" | "deployed" | "deploy-failed";

export function llmHubConfig(home: string, env: NodeJS.ProcessEnv = process.env): LlmHubConfig | null {
  if (env["ORCH_LLM_HUB_WATCH"] !== "1") return null;
  const base = join(homedir(), "sandbox/private");
  const clone = env["ORCH_LLM_HUB_CLONE"];
  // Default paths only for the real orch home, so a test home that boots the server never deploys the live llm-hub.
  if (clone === undefined && home !== join(homedir(), ".harness-orch")) return null;
  return {
    clone: clone ?? join(base, "llm-hub-deploy"),
    releases: env["ORCH_LLM_HUB_RELEASES"] ?? env["LLM_HUB_RELEASES"] ?? join(base, "llm-hub/.releases"),
    ref: env["ORCH_LLM_HUB_REF"] ?? "origin/master",
  };
}

async function git(clone: string, args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["git", "-C", clone, ...args], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(p.stdout).text()).trim();
  return { code: await p.exited, out };
}

/** The sha `<releases>/current` points at, or null before the first deploy. */
export function deployedSha(releases: string): string | null {
  const cur = join(releases, "current");
  if (!existsSync(cur)) return null;
  try {
    return basename(realpathSync(cur));
  } catch {
    return null;
  }
}

function ghCommand(): string {
  return Bun.which("ghx") ? "ghx" : "gh";
}

/** Same rule as deploy-stable.sh: every check run is success, skipped or neutral. */
export function classifyChecks(states: string[]): ChecksState {
  if (states.length === 0) return "pending";
  const ok = new Set(["success", "skipped", "neutral"]);
  const running = new Set(["queued", "in_progress", "pending", "waiting", "requested"]);
  if (states.every((s) => ok.has(s))) return "green";
  if (states.some((s) => !ok.has(s) && !running.has(s))) return "failed";
  return "pending";
}

const defaultReadChecks: ReadChecks = async (clone, sha) => {
  const url = (await git(clone, ["remote", "get-url", "origin"])).out;
  const slug = url.replace(/^.*[:/]([^/:]+\/[^/]+)$/, "$1").replace(/\.git$/, "");
  if (!slug.includes("/")) return "unknown";
  const p = Bun.spawn([ghCommand(), "api", `repos/${slug}/commits/${sha}/check-runs?per_page=100`, "--jq", "[.check_runs[] | (.conclusion // .status)] | join(\",\")"], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(p.stdout).text()).trim();
  if ((await p.exited) !== 0) return "unknown";
  return classifyChecks(out === "" ? [] : out.split(","));
};

const defaultRunDeploy: RunDeploy = async (cfg, logFile) => {
  const script = join(cfg.clone, "scripts/deploy-stable.sh");
  const p = Bun.spawn(["bash", script, "--clone", cfg.clone, "--ref", cfg.ref, "--releases", cfg.releases], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GH: ghCommand() },
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  appendFileSync(logFile, out + err);
  return await p.exited;
};

const stateDir = (home: string): string => join(deployDir(home), "llm-hub");

function failedSha(home: string): string | null {
  try {
    return readFileSync(join(stateDir(home), "failed-sha"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

let running = false;

/** One check. Acts only once a first release exists (`<releases>/current`) and the clone has deploy-stable.sh. A sha whose deploy failed is not retried; a newer master is. */
export async function llmHubWatchTick(
  home: string,
  cfgIn: LlmHubConfig | null = llmHubConfig(home),
  readChecks: ReadChecks = defaultReadChecks,
  runDeploy: RunDeploy = defaultRunDeploy,
): Promise<TickResult> {
  if (cfgIn === null) return "off";
  const cfg = cfgIn;
  if (!existsSync(join(cfg.clone, ".git")) || !existsSync(join(cfg.clone, "scripts/deploy-stable.sh"))) return "off";
  const current = deployedSha(cfg.releases);
  if (current === null) return "off";
  if (running || existsSync(join(cfg.releases, ".deploy.lock"))) return "busy";
  await git(cfg.clone, ["fetch", "-q", "origin"]);
  const head = (await git(cfg.clone, ["rev-parse", `${cfg.ref}^{commit}`])).out;
  if (head === "" || head === current) return "current";
  if (head === failedSha(home)) return "failed-before";
  const checks = await readChecks(cfg.clone, head);
  if (checks === "pending" || checks === "unknown") return "pending";
  if (checks === "failed") return "failed-checks";
  const dir = stateDir(home);
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "deploy.log");
  appendFileSync(log, `\n== ${new Date().toISOString()} deploy ${head} (deployed ${current})\n`);
  running = true;
  try {
    const code = await runDeploy(cfg, log);
    const ok = code === 0 && deployedSha(cfg.releases) === head;
    writeFileSync(join(dir, "failed-sha"), ok ? "" : head);
    appendFileSync(log, `== exit ${code}, current ${deployedSha(cfg.releases)}\n`);
    return ok ? "deployed" : "deploy-failed";
  } finally {
    running = false;
  }
}

export function startLlmHubWatch(home: string, everyMs: number = LLM_HUB_WATCH_MS): () => void {
  const cfg = llmHubConfig(home);
  if (cfg === null) return () => undefined;
  const tick = (): void => void llmHubWatchTick(home, cfg).catch(() => "off");
  const first = setTimeout(tick, 5_000);
  first.unref?.();
  const t = setInterval(tick, everyMs);
  t.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(t);
  };
}
