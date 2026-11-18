// `feedback add|list|show|update`: the feedback store under <home>/feedback. Bun built-ins only.
import { orchHome } from "../state/home.ts";
import { nowIso } from "../state/clock.ts";
import { errLine } from "./node.ts";
import { captured } from "../io.ts";
import {
  addFeedback, filterFeedback, getFeedback, isKind, isSource, isStatus, readFeedback, updateFeedback,
  type FeedbackItem, type FeedbackPatch,
} from "../feedback.ts";

export const FEEDBACK_USAGE = [
  'orch feedback add "<text>" [--kind bug|idea|ux|other] [--source chat|cli|ui] [--chat <id>] [--run <id>] [--node <id>]',
  "orch feedback list [--status new|queued|working|done|wontfix]",
  "orch feedback show <id>",
  'orch feedback update <id> [--status <s>] [--result "<text>"] [--work-run <run-id>]',
  "orch feedback work [--ids fb-a,fb-b]",
].join("\n  ");

// Splits args into positionals and `--flag value` pairs. A flag with no value is an error.
export function parseFeedbackArgs(args: string[]): { pos: string[]; flags: Record<string, string> } {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a.startsWith("--")) {
      if (a === "--json") {
        flags.json = "true";
        continue;
      }
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      flags[a.slice(2)] = v;
      i++;
    } else pos.push(a);
  }
  return { pos, flags };
}

const fmtLine = (i: FeedbackItem): string =>
  `${i.id}  ${i.status.padEnd(8)} ${i.kind.padEnd(5)} ${i.source.padEnd(4)} ${i.text.replace(/\s+/g, " ").slice(0, 80)}`;

export async function feedbackCommand(args: string[]): Promise<number> {
  const [verb = "", ...rest] = args;
  try {
    if (verb === "add") return feedbackAdd(rest);
    if (verb === "list") return feedbackList(rest);
    if (verb === "show") return feedbackShow(rest);
    if (verb === "update") return feedbackUpdate(rest);
    if (verb === "work") return feedbackWork(rest);
  } catch (e) {
    return (errLine(`feedback ${verb}: ${(e as Error).message}`), 2);
  }
  return (errLine(`usage: ${FEEDBACK_USAGE}`), 2);
}

function feedbackAdd(args: string[]): number {
  const { pos, flags } = parseFeedbackArgs(args);
  const text = pos.join(" ");
  if (!text) return (errLine(`usage: orch feedback add "<text>" ...`), 2);
  const source = flags.source ?? "cli";
  if (!isSource(source)) throw new Error(`bad source "${source}" (chat|cli|ui)`);
  const kind = flags.kind ?? "other";
  if (!isKind(kind)) throw new Error(`bad kind "${kind}" (bug|idea|ux|other)`);
  const item = addFeedback(orchHome(), {
    text, source, kind, chat_id: flags.chat, run_id: flags.run, node_id: flags.node,
  }, nowIso());
  process.stdout.write(`${item.id}\n`);
  return 0;
}

function feedbackList(args: string[]): number {
  const { flags } = parseFeedbackArgs(args);
  const status = flags.status;
  if (status !== undefined && !isStatus(status)) throw new Error(`bad status "${status}" (new|queued|working|done|wontfix)`);
  const items = filterFeedback(readFeedback(orchHome()), { status });
  if (items.length === 0) process.stdout.write("no feedback\n");
  for (const i of items) process.stdout.write(fmtLine(i) + "\n");
  return 0;
}

function feedbackShow(args: string[]): number {
  const id = args[0] ?? "";
  if (!id) return (errLine("usage: orch feedback show <id>"), 2);
  const item = getFeedback(orchHome(), id);
  if (!item) return (errLine(`no feedback ${id}`), 1);
  process.stdout.write(JSON.stringify(item, null, 2) + "\n");
  return 0;
}

function feedbackUpdate(args: string[]): number {
  const { pos, flags } = parseFeedbackArgs(args);
  const id = pos[0] ?? "";
  if (!id) return (errLine("usage: orch feedback update <id> [--status s] [--result t] [--work-run r]"), 2);
  const patch: FeedbackPatch = {};
  if (flags.status !== undefined) patch.status = flags.status as FeedbackPatch["status"];
  if (flags.result !== undefined) patch.result = flags.result;
  if (flags["work-run"] !== undefined) patch.work_run = flags["work-run"];
  if (Object.keys(patch).length === 0) return (errLine("feedback update: give --status, --result or --work-run"), 2);
  const item = updateFeedback(orchHome(), id, patch, nowIso());
  process.stdout.write(fmtLine(item) + "\n");
  return 0;
}

// runs.ts writes its run id straight to process.stdout, outside the captured store. Drop it for one call.
async function quietStdout<T>(fn: () => Promise<T>): Promise<T> {
  const w = process.stdout.write;
  process.stdout.write = (() => true) as typeof w;
  try {
    return await fn();
  } finally {
    process.stdout.write = w;
  }
}

export interface FeedbackWorkResult {
  run_id: string;
  items: string[];
}

// Runs the batch for the given ids, or for every item with status new. One run titled "feedback batch",
// one node per item, then a validation node that waits on all of them. Items go queued, then working.
// The nodes are added, not dispatched: dispatch is a separate step.
export async function feedbackWorkBatch(ids?: string[]): Promise<FeedbackWorkResult | null> {
  const home = orchHome();
  const all = readFeedback(home);
  const picked = ids
    ? ids.map((id) => {
        const item = all.find((i) => i.id === id);
        if (!item) throw new Error(`no feedback ${id}`);
        if (item.status !== "new") throw new Error(`${id} is ${item.status}, only new items can be worked`);
        return item;
      })
    : filterFeedback(all, { status: "new" });
  if (picked.length === 0) return null;

  const { runStart } = await import("./runs.ts");
  const { nodeAdd } = await import("./node.ts");
  const stamp = nowIso().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  const runId = `feedback-batch-${stamp}`;
  const started = await captured({}, () => quietStdout(() => runStart(["feedback batch", "--id", runId])));
  if (started.code !== 0) throw new Error(`run start failed: ${started.stderr.trim()}`);

  for (const item of picked) {
    const label = item.text.replace(/\s+/g, " ").slice(0, 80);
    const rc = await captured({}, () => nodeAdd([runId, item.id, label, "--acceptance", `fixes feedback ${item.id}: ${item.text}`]));
    if (rc.code !== 0) throw new Error(`node add ${item.id} failed: ${rc.stderr.trim()}`);
  }
  // No own validate node: every run already has the after_all "done-gate" node, which verifies the batch.

  for (const item of picked) updateFeedback(home, item.id, { status: "queued", work_run: runId }, nowIso());
  for (const item of picked) updateFeedback(home, item.id, { status: "working" }, nowIso());
  return { run_id: runId, items: picked.map((i) => i.id) };
}

async function feedbackWork(args: string[]): Promise<number> {
  const { flags } = parseFeedbackArgs(args);
  const ids = flags.ids?.split(",").map((s) => s.trim()).filter(Boolean);
  const res = await feedbackWorkBatch(ids);
  if (flags.json !== undefined) {
    process.stdout.write(JSON.stringify(res ?? { run_id: null, items: [] }) + "\n");
    return 0;
  }
  if (!res) {
    process.stdout.write("no new feedback\n");
    return 0;
  }
  process.stdout.write(`run ${res.run_id}: ${res.items.length} item(s) queued and working: ${res.items.join(" ")}\n`);
  return 0;
}
