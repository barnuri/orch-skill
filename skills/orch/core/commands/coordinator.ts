// Orchestrator sessions orch starts itself: model setting, start and rotation at a context limit.
//   orchestrator start  <run> [--handoff FILE] [--dry-run]
//   orchestrator rotate <run> --tokens N [--summary TEXT] [--dry-run]
// `coordinator` remains an alias.
// Settings (profiles.json `settings`): coordinator_model, coordinator_rotate_tokens.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { orchHome, paths } from "../state/home.ts";
import { loadProfilesDoc, settingFrom, settingUintFrom } from "../state/settings.ts";
import { appendEvents, loadRun } from "../state/store.ts";
import { nowIso } from "../state/clock.ts";

export const COORDINATOR_MODEL_DEFAULT = "hub/copilot/mai-code-2-flash";
export const COORDINATOR_ROTATE_TOKENS_DEFAULT = 200000;
export const ORCHESTRATOR_USAGE = "dispatch.ts orchestrator start <run> [--handoff FILE] [--dry-run] | orchestrator register <run> | orchestrator rotate <run> --tokens N [--summary TEXT] [--dry-run]";
export const COORDINATOR_USAGE = ORCHESTRATOR_USAGE;

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
    `You are the orch orchestrator for run ${run}. Load the orch skill first.`,
    "Dispatch every task as an orch node (dispatch.ts node add / node dispatch); never start foreground subagents.",
    "Do not run tests or typecheck yourself; child nodes run targeted tests and report results.",
    "Profiles: implementation nodes use opencode-chip-exec (Haiku, mai models). Sonnet (opencode-sonnet-verify) is only for the final review node. Never change a node to another profile to get around a failure: replace the node with `node replace` (same goal and prompt) and keep the profile.",
    "Failures: a node that errors is retried by the run watch; after its attempts run out, use `node replace`. Never mark a node done by hand.",
  ];
  if (handoff) lines.push(`Continue from the handoff of the previous orchestrator: read ${handoff} first.`);
  return lines.join(" ");
}

export function coordinatorArgv(model: string, prompt: string): string[] {
  // This opencode version takes --model and the message on `run`; the top-level command rejects both.
  return ["opencode", "run", "--model", model, prompt];
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
  // The coordinator needs the provider definition that the chip profile carries, or its model is unknown.
  // The job's launcher exports whatever env.json holds, so the config reaches opencode.
  const cfg = ((await loadProfilesDoc(home)) as any)?.profiles?.["opencode-chip-exec"]?.env?.OPENCODE_CONFIG_CONTENT;
  if (typeof cfg === "string") {
    // The provider config reads {env:LLM_HUB_V1_URL} and {env:LLM_HUB_KEY}: give the job both, as node jobs get them.
    const base = (process.env.LLM_HUB_URL || "http://127.0.0.1:8888").replace(/\/+$/, "").replace(/\/v1$/, "");
    writeFileSync(join(jobDir, "env.json"), JSON.stringify({
      OPENCODE_CONFIG_CONTENT: cfg,
      LLM_HUB_V1_URL: `${base}/v1`,
      LLM_HUB_KEY: process.env.LLM_HUB_KEY || "local",
    }));
  }
  const { startJob } = await import("../adapters/herdr.ts");
  const started = await startJob(home, jobDir, argv).catch(() => false);
  await appendEvents(home, run, [{ at: nowIso(), kind: "note", node: null, from: null, to: null, note: `orchestrator started: model ${model}${handoff ? `, handoff ${handoff}` : ""}`, by: "orch" }]).catch(() => undefined);
  if (started) return out(`orchestrator started in herdr: ${model} (${jobDir})\n`);
  return out(`herdr unavailable; start the orchestrator with:\n${argv.map((a) => JSON.stringify(a)).join(" ")}\n`);
}

export async function coordinatorStart(args: string[]): Promise<number> {
  const run = args[0] ?? "";
  if (!run || run.startsWith("--")) return err(`usage: ${ORCHESTRATOR_USAGE}\n`, 2);
  const home = orchHome();
  if (!(await loadRun(home, run))) return err(`orchestrator start: no run ${run}\n`, 1);
  return launch(home, run, flag(args, "--handoff"), args.includes("--dry-run"));
}

// Prints `ok` below the threshold. At or above it, writes a handoff file in the run folder and starts a fresh coordinator.
export async function coordinatorRotate(args: string[]): Promise<number> {
  const run = args[0] ?? "";
  const tokens = Number(flag(args, "--tokens"));
  if (!run || run.startsWith("--") || !Number.isFinite(tokens) || flag(args, "--tokens") === null) return err(`usage: ${ORCHESTRATOR_USAGE}\n`, 2);
  const home = orchHome();
  const st = await loadRun(home, run);
  if (!st) return err(`orchestrator rotate: no run ${run}\n`, 1);
  const { rotateTokens } = coordinatorSettingsFrom(await loadProfilesDoc(home));
  if (!needsRotation(tokens, rotateTokens)) return out(`ok: ${tokens} < ${rotateTokens}, no rotation\n`);
  const dir = join(paths.runs(home), run, "coordinator-handoffs");
  mkdirSync(dir, { recursive: true });
  let file = join(dir, `${nowIso().replace(/[:.]/g, "-")}.md`);
  for (let i = 2; existsSync(file); i++) file = file.replace(/(-\d+)?\.md$/, `-${i}.md`);
  const open = st.nodes.filter((n) => n.status !== "done").map((n) => `- ${n.id}: ${n.status ?? "?"}${n.label ? ` — ${n.label}` : ""}`);
  const body = [
    `# Orchestrator handoff: run ${run}`,
    "",
    `Rotated at ${tokens} context tokens (threshold ${rotateTokens}), ${nowIso()}.`,
    "",
    "## Summary from the previous orchestrator",
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
  if (code === 0) out("The new orchestrator takes over now. End this session after your current turn.\n");
  return code;
}
