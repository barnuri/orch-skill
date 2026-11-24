// Orchestrator sessions orch starts itself: model setting, start and rotation at a context limit.
//   orchestrator start  <run> [--handoff FILE] [--dry-run]
//   orchestrator rotate <run> --tokens N [--summary TEXT] [--dry-run]
//   orchestrator check  <run> [--dry-run]   reads the coordinator session's prompt size and rotates at the limit
// `coordinator` remains an alias.
// Settings (profiles.json `settings`): coordinator_model, coordinator_rotate_tokens, coordinator_allow_1m.
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { orchHome, paths } from "../state/home.ts";
import { loadProfilesDoc, settingFrom, settingUintFrom } from "../state/settings.ts";
import { appendEvents, loadRun } from "../state/store.ts";
import { nowIso } from "../state/clock.ts";
import { opencodeDbPath } from "./owners.ts";

export const COORDINATOR_MODEL_DEFAULT = "hub/copilot/mai-code-2-flash";
export const COORDINATOR_ROTATE_TOKENS_DEFAULT = 200000;
// A rotation gets this long to start the fresh orchestrator before the check may rotate again.
export const ROTATE_COOLDOWN_MS = 15 * 60_000;
export const ORCHESTRATOR_USAGE = "dispatch.ts orchestrator start <run> [--handoff FILE] [--dry-run] | orchestrator register <run> | orchestrator rotate <run> --tokens N [--summary TEXT] [--dry-run] | orchestrator check <run> [--dry-run]";
export const COORDINATOR_USAGE = ORCHESTRATOR_USAGE;

type Doc = Parameters<typeof settingFrom>[0];

export function coordinatorSettingsFrom(doc: Doc): { model: string; rotateTokens: number; allow1m: boolean } {
  return {
    model: settingFrom(doc, "coordinator_model", COORDINATOR_MODEL_DEFAULT),
    rotateTokens: settingUintFrom(doc, "coordinator_rotate_tokens", COORDINATOR_ROTATE_TOKENS_DEFAULT),
    allow1m: settingFrom(doc, "coordinator_allow_1m", "false") === "true",
  };
}

export function needsRotation(tokens: number, threshold: number): boolean {
  return Number.isFinite(tokens) && tokens >= threshold;
}

// A `[1m]` model id selects the 1M-token context tier, which the orchestrator must not run on by default.
export function is1mModel(model: string): boolean {
  return model.endsWith("[1m]");
}

// Prompt size of the session's newest assistant message: input + cache read + cache write, as opencode reports it.
// Reads opencode.db read-only. null when the db or the session has no assistant message with token counts.
export function latestPromptTokens(sessionId: string, dbPath: string = opencodeDbPath()): number | null {
  if (!/^ses_[A-Za-z0-9]+$/.test(sessionId) || !existsSync(dbPath)) return null;
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.query(
        `select json_extract(data,'$.tokens.input') as i, json_extract(data,'$.tokens.cache.read') as r,
                json_extract(data,'$.tokens.cache.write') as w
           from session_message where session_id = ? and type = 'assistant' and json_extract(data,'$.tokens') is not null
           order by seq desc limit 1`,
      ).get(sessionId) as { i: number | null; r: number | null; w: number | null } | null;
      if (!row) return null;
      return Math.round((row.i ?? 0) + (row.r ?? 0) + (row.w ?? 0));
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
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
  const { model, allow1m } = coordinatorSettingsFrom(await loadProfilesDoc(home));
  if (is1mModel(model) && !allow1m) {
    return err(`orchestrator: model ${model} is a [1m] model; set settings.coordinator_allow_1m to true to run an orchestrator on it, or set settings.coordinator_model to a non-[1m] model\n`, 2);
  }
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
  return rotateTo(home, run, tokens, rotateTokens, flag(args, "--summary"), args.includes("--dry-run"));
}

// The check the watchdog runs on a timer: reads the coordinator session's prompt size from opencode.db, and rotates
// when it reaches settings.coordinator_rotate_tokens. Prints one line: `ok`, `no session`, `unknown`, `cooldown`, or `rotate`.
export async function coordinatorCheck(args: string[]): Promise<number> {
  const run = args[0] ?? "";
  if (!run || run.startsWith("--")) return err(`usage: ${ORCHESTRATOR_USAGE}\n`, 2);
  const home = orchHome();
  const st = await loadRun(home, run);
  if (!st) return err(`orchestrator check: no run ${run}\n`, 1);
  const session = (st.coordinator as { session_id?: unknown } | null | undefined)?.session_id;
  if (typeof session !== "string" || !session) return out("no session\n");
  const { rotateTokens } = coordinatorSettingsFrom(await loadProfilesDoc(home));
  const tokens = latestPromptTokens(session);
  if (tokens === null) return out("unknown\n");
  if (!needsRotation(tokens, rotateTokens)) return out(`ok: ${tokens} < ${rotateTokens}\n`);
  const last = latestHandoffMs(join(paths.runs(home), run, "coordinator-handoffs"));
  if (last !== null && Date.now() - last < ROTATE_COOLDOWN_MS) return out(`cooldown: ${tokens} >= ${rotateTokens}, last handoff under ${ROTATE_COOLDOWN_MS / 60_000} min ago\n`);
  return rotateTo(home, run, tokens, rotateTokens, null, args.includes("--dry-run"));
}

function latestHandoffMs(dir: string): number | null {
  if (!existsSync(dir)) return null;
  const times = readdirSync(dir).map((f) => statSync(join(dir, f)).mtimeMs);
  return times.length ? Math.max(...times) : null;
}

// Writes the handoff from the run state, then starts a fresh orchestrator on it.
async function rotateTo(home: string, run: string, tokens: number, rotateTokens: number, summary: string | null, dry: boolean): Promise<number> {
  const st = await loadRun(home, run);
  if (!st) return err(`orchestrator rotate: no run ${run}\n`, 1);
  const { model, allow1m } = coordinatorSettingsFrom(await loadProfilesDoc(home));
  if (is1mModel(model) && !allow1m) return err(`orchestrator: model ${model} is a [1m] model; no handoff written\n`, 2);
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
    summary ?? "(none given)",
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
  const code = await launch(home, run, file, dry);
  if (code === 0) out("The new orchestrator takes over now. End this session after your current turn.\n");
  return code;
}

