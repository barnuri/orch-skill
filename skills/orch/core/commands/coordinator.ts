// Coordinator sessions orch starts itself: model setting, start and rotation at a context limit.
//   coordinator start  <run> [--handoff FILE] [--dry-run]
//   coordinator rotate <run> --tokens N [--summary TEXT] [--dry-run]
// Settings (profiles.json `settings`): coordinator_model, coordinator_rotate_tokens.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { orchHome, paths } from "../state/home.ts";
import { loadProfilesDoc, settingFrom, settingUintFrom } from "../state/settings.ts";
import { appendEvents, loadRun } from "../state/store.ts";
import { nowIso } from "../state/clock.ts";

export const COORDINATOR_MODEL_DEFAULT = "llm-hub/copilot/claude-sonnet-5-5";
export const COORDINATOR_ROTATE_TOKENS_DEFAULT = 200000;
export const COORDINATOR_USAGE = "dispatch.ts coordinator start <run> [--handoff FILE] [--dry-run] | coordinator rotate <run> --tokens N [--summary TEXT] [--dry-run]";

type Doc = Parameters<typeof settingFrom>[0];

export function coordinatorSettingsFrom(doc: Doc): { model: string; rotateTokens: number } {
  return {
    model: settingFrom(doc, "coordinator_model", COORDINATOR_MODEL_DEFAULT),
    rotateTokens: settingUintFrom(doc, "coordinator_rotate_tokens", COORDINATOR_ROTATE_TOKENS_DEFAULT),
  };
}

export function needsRotation(tokens: number, threshold: number): boolean {
  return Number.isFinite(tokens) && tokens >= threshold;
}

export function coordinatorPrompt(run: string, handoff: string | null): string {
  const lines = [
    `You are the orch coordinator for run ${run}. Load the orch skill first.`,
    "Dispatch every task as an orch node (dispatch.ts node add / node dispatch); never start foreground subagents.",
    "Do not run tests or typecheck yourself; child nodes run targeted tests and report results.",
  ];
  if (handoff) lines.push(`Continue from the handoff of the previous coordinator: read ${handoff} first.`);
  return lines.join(" ");
}

export function coordinatorArgv(model: string, prompt: string): string[] {
  return ["opencode", "--model", model, "--prompt", prompt];
}

function flag(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1]! : null;
}

const out = (s: string): number => (process.stdout.write(s), 0);
const err = (s: string, code: number): number => (process.stderr.write(s), code);

async function launch(home: string, run: string, handoff: string | null, dry: boolean): Promise<number> {
  const { model } = coordinatorSettingsFrom(await loadProfilesDoc(home));
  const argv = coordinatorArgv(model, coordinatorPrompt(run, handoff));
  if (dry) return out(JSON.stringify(argv) + "\n");
  const jobDir = join(paths.jobs(home), `coordinator-${run}-${Date.now()}`);
  mkdirSync(jobDir, { recursive: true });
  process.env.ORCH_RUN_ID = run;
  process.env.ORCH_NODE_ID = "coordinator";
  const { startJob } = await import("../adapters/herdr.ts");
  const started = await startJob(home, jobDir, argv).catch(() => false);
  await appendEvents(home, run, [{ at: nowIso(), kind: "note", node: null, from: null, to: null, note: `coordinator started: model ${model}${handoff ? `, handoff ${handoff}` : ""}`, by: "orch" }]).catch(() => undefined);
  if (started) return out(`coordinator started in herdr: ${model} (${jobDir})\n`);
  return out(`herdr unavailable; start the coordinator with:\n${argv.map((a) => JSON.stringify(a)).join(" ")}\n`);
}

export async function coordinatorStart(args: string[]): Promise<number> {
  const run = args[0] ?? "";
  if (!run || run.startsWith("--")) return err(`usage: ${COORDINATOR_USAGE}\n`, 2);
  const home = orchHome();
  if (!(await loadRun(home, run))) return err(`coordinator start: no run ${run}\n`, 1);
  return launch(home, run, flag(args, "--handoff"), args.includes("--dry-run"));
}

// Prints `ok` below the threshold. At or above it, writes a handoff file in the run folder and starts a fresh coordinator.
export async function coordinatorRotate(args: string[]): Promise<number> {
  const run = args[0] ?? "";
  const tokens = Number(flag(args, "--tokens"));
  if (!run || run.startsWith("--") || !Number.isFinite(tokens) || flag(args, "--tokens") === null) return err(`usage: ${COORDINATOR_USAGE}\n`, 2);
  const home = orchHome();
  const st = await loadRun(home, run);
  if (!st) return err(`coordinator rotate: no run ${run}\n`, 1);
  const { rotateTokens } = coordinatorSettingsFrom(await loadProfilesDoc(home));
  if (!needsRotation(tokens, rotateTokens)) return out(`ok: ${tokens} < ${rotateTokens}, no rotation\n`);
  const dir = join(paths.runs(home), run, "coordinator-handoffs");
  mkdirSync(dir, { recursive: true });
  let file = join(dir, `${nowIso().replace(/[:.]/g, "-")}.md`);
  for (let i = 2; existsSync(file); i++) file = file.replace(/(-\d+)?\.md$/, `-${i}.md`);
  const open = st.nodes.filter((n) => n.status !== "done").map((n) => `- ${n.id}: ${n.status ?? "?"}${n.label ? ` — ${n.label}` : ""}`);
  const body = [
    `# Coordinator handoff: run ${run}`,
    "",
    `Rotated at ${tokens} context tokens (threshold ${rotateTokens}), ${nowIso()}.`,
    "",
    "## Summary from the previous coordinator",
    "",
    flag(args, "--summary") ?? "(none given)",
    "",
    "## Open nodes",
    "",
    ...(open.length ? open : ["(none)"]),
    "",
    `Read state with: dispatch.ts run status ${run}`,
    "",
  ].join("\n");
  writeFileSync(file, body);
  out(`rotate: ${tokens} >= ${rotateTokens}; handoff ${file}\n`);
  const code = await launch(home, run, file, args.includes("--dry-run"));
  if (code === 0) out("The new coordinator takes over now. End this session after your current turn.\n");
  return code;
}
