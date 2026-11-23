import { durationSecs } from "../../../../src/shared/chat-automation.ts";
import { orchHome } from "../state/home.ts";
import { ensureHome } from "../state/profiles.ts";
import { loadProfilesDoc } from "../state/settings.ts";
import { profileRequire } from "./dispatch.ts";
import { planCommand } from "./plan.ts";
import { runStart } from "./runs.ts";
import { runAdvance } from "./advance.ts";
import { reqAdd } from "./req.ts";

export const GOAL_USAGE = 'dispatch.ts goal "<goal>|@file" [--id ID] [--profile P] [--node ID] [--dry-run] [--interval SECS] [--timeout SECS] [--until-done] [--no-finish] [--stop-on blocked|error|timeout|all]';

interface GoalOptions {
  readonly goal: string;
  readonly id: string;
  readonly profile: string;
  readonly node: string;
  readonly dryRun: boolean;
  readonly interval: string;
  readonly timeout: string;
  readonly untilDone: boolean;
  readonly finish: boolean;
  readonly stopOn: "blocked" | "error" | "timeout" | "all";
}

function parseDuration(value: string): string | null {
  if (/^[0-9]+$/.test(value)) return value;
  const secs = durationSecs(value);
  return secs === null ? null : String(secs);
}

export function parseGoalArgs(args: string[]): { options: GoalOptions | null; error: string | null } {
  let goal = "";
  let id = "";
  let profile = "";
  let node = "plan";
  let dryRun = false;
  let interval = "15";
  let timeout = "0";
  let untilDone = true;
  let finish = true;
  let stopOn: GoalOptions["stopOn"] = "all";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--id") id = args[++i] ?? "";
    else if (arg === "--profile") profile = args[++i] ?? "";
    else if (arg === "--node") node = args[++i] ?? "";
    else if (arg === "--interval") interval = args[++i] ?? "";
    else if (arg === "--timeout") timeout = args[++i] ?? "";
    else if (arg === "--until-done") untilDone = true;
    else if (arg === "--no-finish") finish = false;
    else if (arg === "--stop-on") stopOn = (args[++i] ?? "") as GoalOptions["stopOn"];
    else if (arg === "--stop-on-blocked") stopOn = "blocked";
    else if (arg === "--stop-on-error") stopOn = "error";
    else if (arg === "--stop-on-timeout") stopOn = "timeout";
    else if (arg.startsWith("-")) return { options: null, error: `goal: unknown argument ${arg}\n  usage: ${GOAL_USAGE}\n` };
    else if (goal === "") goal = arg;
    else return { options: null, error: `goal: unexpected argument ${arg}\n  usage: ${GOAL_USAGE}\n` };
  }

  if (!goal) return { options: null, error: `usage: ${GOAL_USAGE}\n` };
  if (!["blocked", "error", "timeout", "all"].includes(stopOn)) {
    return { options: null, error: `goal: --stop-on must be blocked, error, timeout, or all\n` };
  }
  const parsedInterval = parseDuration(interval);
  const parsedTimeout = parseDuration(timeout);
  if (parsedInterval === null || parsedInterval === "0" || parsedTimeout === null) {
    return { options: null, error: "goal: --interval must be a positive duration; --timeout must be a duration or seconds\n" };
  }
  return { options: { goal, id, profile, node, dryRun, interval: parsedInterval, timeout: parsedTimeout, untilDone, finish, stopOn }, error: null };
}

export async function goalCommand(args: string[]): Promise<number> {
  const parsed = parseGoalArgs(args);
  if (parsed.error) {
    process.stderr.write(parsed.error);
    return 2;
  }
  const options = parsed.options!;

  let goalText = options.goal;
  if (goalText.startsWith("@")) {
    const file = Bun.file(goalText.slice(1));
    if (!(await file.exists())) {
      process.stderr.write(`goal: goal file not found: ${goalText.slice(1)}\n`);
      return 1;
    }
    goalText = await file.text();
  }
  if (goalText.trim() === "") {
    process.stderr.write("goal: goal cannot be empty\n");
    return 2;
  }

  const home = orchHome();
  if (options.dryRun) {
    const doc = await loadProfilesDoc(home).catch(() => null);
    const profile = options.profile || String(doc?.settings?.planner_profile ?? "");
    process.stdout.write(`goal dry-run: ${goalText.trim()}\nprofile: ${profile || "default planner"}\nstop-on: ${options.stopOn}\ninterval: ${options.interval}s\ntimeout: ${options.timeout}s\nfinish: ${options.finish ? "yes" : "no"}\n`);
    return 0;
  }

  if (!(await ensureHome(home))) return 1;
  if (options.profile && !(await profileRequire(home, options.profile))) return 2;

  const startArgs = [`Goal: ${goalText.trim().slice(0, 80)}`];
  if (options.id) startArgs.push("--id", options.id);
  let runId = "";
  const write = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (text: string) => { runId = String(text).trim(); return true; };
  let startRc = 0;
  try {
    startRc = await runStart(startArgs);
  } finally {
    (process.stdout as any).write = write;
  }
  if (startRc !== 0) return 1;
  if (!runId) return 1;

  const planArgs = [runId, goalText, "--node", options.node];
  if (options.profile) planArgs.push("--profile", options.profile);
  if ((await planCommand(planArgs)) !== 0) return 1;
  if ((await reqAdd([runId, goalText.trim(), "--id", "R1", "--node", options.node])) !== 0) return 1;

  process.stdout.write(`run: ${runId}\n`);
  const advanceArgs = [runId, "--interval", options.interval, "--timeout", options.timeout, "--stop-on", options.stopOn];
  if (options.untilDone) advanceArgs.push("--until-done");
  if (!options.finish) advanceArgs.push("--no-finish");

  const rc = await runAdvance(advanceArgs);
  if (rc !== 0) {
    process.stdout.write(`goal stopped: ${options.stopOn} (run ${runId}, exit ${rc})\n`);
  }
  return rc;
}
