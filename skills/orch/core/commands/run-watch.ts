// `run watch <run-id> [--json] [--stall-min N]`: restarts `run wait` until the run ends. Each wait batch prints
// its events as they come. The end is read from the run's state, not from wait's exit code: exit 3 means the run
// is settled (nothing running or ready), not ended. Exits 0 when the run ends, 2 on a bad run or argument.
import { loadRun } from "../state/store.ts";
import { orchHome } from "../state/home.ts";
import { BIN_ORCH } from "../state/proc.ts";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { findNode } from "../runs/node.ts";

export const RUN_WATCH_USAGE = "dispatch.ts run watch <run-id> [--json] [--stall-min N]";
const MAX_CRASHES = 5;
// Keep the run green without the coordinator: retry errored nodes (within max_attempts) and nudge idle ones.
const RETRY_GAP_MS = 60_000;
const MAX_AUTO_ATTEMPTS = 5;
const retriedAt: Record<string, number> = {};

async function deliverMailbox(home: string, runId: string, pass: string[]): Promise<void> {
  const mailbox = join(home, "runs", runId, "messages.jsonl");
  const run = await loadRun(home, runId);
  if (!run) return;
  const cursorFile = join(home, "runs", runId, "mailbox-watch.cursor");
  const cursor = Number((await readFile(cursorFile, "utf8").catch(() => "0")).trim()) || 0;
  const lines = (await readFile(mailbox, "utf8").catch(() => "")).split("\n").filter((line) => line.trim());
  for (let index = cursor; index < lines.length; index++) {
    let message: { from?: string; to?: string; text?: string; ts?: string };
    try {
      message = JSON.parse(lines[index]!);
    } catch {
      continue;
    }
    const targets = message.to === "all" ? (run.nodes ?? []).map((node) => node.id) : [message.to ?? ""];
    for (const nodeId of targets) {
      if (!nodeId || nodeId === "orch") continue;
      if (!findNode(run, nodeId)) continue;
      const node = findNode(run, nodeId)!;
      const outDir = node.out_dir ? String(node.out_dir) : join(home, "runs", runId, "out", nodeId);
      await mkdir(outDir, { recursive: true });
      await appendFile(join(outDir, "inbox.md"), `[${message.ts ?? ""} ${message.from ?? "orch"} -> ${nodeId}] ${message.text ?? ""}\n`);
    }
  }
  await Bun.write(cursorFile, String(lines.length) + "\n");
}

let lastGreen = 0;
async function keepGreen(home: string, runId: string, pass: string[]): Promise<void> {
  if (Date.now() - lastGreen < 30_000) return;
  lastGreen = Date.now();
  const run = await loadRun(home, runId);
  if (!run) return;
  for (const [id, node] of Object.entries(run.nodes ?? {})) {
    const n = node as { status?: string; error?: string | null };
    if (n.status !== "error" || /cancel/i.test(n.error ?? "")) continue;
    const key = `${runId}/${id}`;
    if (Date.now() - (retriedAt[key] ?? 0) < RETRY_GAP_MS) continue;
    retriedAt[key] = Date.now();
    const attempts = Array.isArray((node as { attempts?: unknown[] }).attempts) ? (node as { attempts: unknown[] }).attempts.length : 0;
    // Attempts used up: replace the node with a fresh one (same goal, prompt, profile) and mark this one covered.
    const verb = attempts >= MAX_AUTO_ATTEMPTS ? ["node", "replace", runId, id] : ["node", "retry", runId, id];
    const p = Bun.spawn([process.execPath, BIN_ORCH, ...verb], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    process.stdout.write(`auto-retry ${id}: ${out.trim().split("\n").pop() ?? ""}\n`);
  }
  // Fire and forget: the nudge must never hold up the event loop.
  Bun.spawn([process.execPath, BIN_ORCH, "run", "health", runId, "--nudge"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
}

export async function runWatch(args: string[]): Promise<number> {
  const home = orchHome();
  let runId = "";
  const pass: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--json") pass.push(a);
    else if (a === "--stall-min") pass.push(a, args[++i] ?? "");
    else if (a.startsWith("-")) return (process.stderr.write(`run watch: unknown argument ${a}\n  usage: ${RUN_WATCH_USAGE}\n`), 2);
    else if (runId) return (process.stderr.write(`usage: ${RUN_WATCH_USAGE}\n`), 2);
    else runId = a;
  }
  if (!runId) return (process.stderr.write(`usage: ${RUN_WATCH_USAGE}\n`), 2);

  let crashes = 0;
  for (;;) {
    await deliverMailbox(home, runId, pass);
    const before = await loadRun(home, runId);
    if (!before) return (process.stderr.write(`run ${runId}: unknown run\n`), 2);
    if (before.status !== "running") return 0;

    const proc = Bun.spawn([process.execPath, BIN_ORCH, "run", "wait", runId, ...pass], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    const code = await proc.exited;
    if (code === 2) return 2;

    const after = await loadRun(home, runId);
    if (!after) return (process.stderr.write(`run ${runId}: unknown run\n`), 2);
    if (after.status !== "running") return 0;
    await deliverMailbox(home, runId, pass);
    await keepGreen(home, runId, pass);

    // Exit 0 (events) and 3 (settled) restart at once: wait blocks on its own cursor until the next change.
    // Any other exit is a crash; give up after MAX_CRASHES in a row, with a pause between tries.
    if (code === 0 || code === 3) {
      crashes = 0;
      continue;
    }
    crashes++;
    if (crashes >= MAX_CRASHES) return (process.stderr.write(`run watch: run wait exited ${code} ${MAX_CRASHES} times in a row\n`), 1);
    await Bun.sleep(1000);
  }
}
