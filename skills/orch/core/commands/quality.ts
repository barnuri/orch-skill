// `node quality <append|show|list|export> ...`: generic quality reports per run/node/model.
// Writes go through mutateRun (the dispatcher owns state.json); reads only load the run.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { orchHome } from "../state/home.ts";
import { loadRun } from "../state/store.ts";
import { ADAPTERS, adapterNames } from "../quality/adapters.ts";
import { finalizeQualityReport, type QualityReport } from "../quality/contract.ts";
import { exportReports } from "../quality/export.ts";
import { OpError } from "../runs/node.ts";
import { errLine, mutateRun, resolveRun } from "./node.ts";

export const QUALITY_USAGE = [
  "node quality append <run> <node> --file <path> --stage <implementation|review|final-review> --skill <id> [--adapter generic|cr-markdown] [--model-requested M] [--model-actual M] [--reviewer-model M] [--started-at T] [--finished-at T] [--source <path>]",
  "node quality show <run> <node> [--id qN]",
  "node quality list <run> [--node N] [--model M]",
  "node quality export <run> [--node N] [--model M]",
].join("\n  ");

type Flags = Record<string, string>;

/** Splits `--key value` pairs from positional words. Unknown flags are an error. */
export function parseQualityArgs(args: string[], known: string[]): { pos: string[]; flags: Flags } {
  const pos: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const key = a.slice(2);
    if (!known.includes(key)) throw new Error(`node quality: unknown argument ${a}\n  usage: ${QUALITY_USAGE}`);
    const v = args[++i];
    if (v === undefined || v.startsWith("--")) throw new Error(`node quality: --${key} needs a value`);
    flags[key] = v;
  }
  return { pos, flags };
}

const APPEND_FLAGS = ["file", "adapter", "stage", "skill", "model-requested", "model-actual", "reviewer-model", "started-at", "finished-at", "source"];
const FILTER_FLAGS = ["node", "model"];

function matchesModel(r: QualityReport, m: string): boolean {
  return r.model.actual === m || r.model.requested === m;
}

function filterReports(reports: QualityReport[], flags: Flags): QualityReport[] {
  return reports.filter((r) => (!flags.node || r.node_id === flags.node) && (!flags.model || matchesModel(r, flags.model)));
}

export async function nodeQuality(args: string[]): Promise<number> {
  const [verb = "", ...rest] = args;
  const home = orchHome();
  try {
    if (verb === "append") return await qualityAppend(home, rest);
    if (verb === "show") return await qualityShow(home, rest);
    if (verb === "list") return await qualityList(home, rest);
    if (verb === "export") return await qualityExport(home, rest);
  } catch (e) {
    errLine((e as Error).message);
    return 2;
  }
  errLine(`usage: ${QUALITY_USAGE}`);
  return 2;
}

async function qualityAppend(home: string, args: string[]): Promise<number> {
  const { pos, flags } = parseQualityArgs(args, APPEND_FLAGS);
  const [runArg = "", nodeId = ""] = pos;
  if (!runArg || !nodeId || !flags.file) throw new Error(`usage: node quality append <run> <node> --file <path> --stage <S> --skill <id>`);
  const adapterName = flags.adapter ?? "generic";
  const adapter = ADAPTERS[adapterName];
  if (!adapter) throw new Error(`node quality: --adapter must be one of ${adapterNames().join(" ")}`);
  const filePath = resolve(flags.file);
  const text = readFileSync(filePath, "utf8");
  const draft = adapter(text) as Record<string, any>;
  // CLI flags override the adapter's values; the adapter output is never trusted over an explicit flag.
  if (flags.stage) draft.stage = flags.stage;
  if (flags.skill) draft.skill_id = flags.skill;
  draft.model = { requested: flags["model-requested"] ?? draft.model?.requested ?? null, actual: flags["model-actual"] ?? draft.model?.actual ?? null };
  draft.reviewer_model = flags["reviewer-model"] ?? draft.reviewer_model ?? null;
  draft.timestamps = { started_at: flags["started-at"] ?? draft.timestamps?.started_at ?? null, finished_at: flags["finished-at"] ?? draft.timestamps?.finished_at ?? null };
  draft.source_artifact = flags.source ?? filePath;
  const runId = await resolveRun(home, runArg);
  if (runId === null) return 1;
  let added = "";
  const rc = await mutateRun(home, runId, (run, ctx) => {
    const n = (run.nodes as Array<{ id: string }>).find((x) => x.id === nodeId);
    if (!n) throw new OpError(`node ${nodeId}: not in this run`);
    const list: QualityReport[] = (run.quality ??= []);
    const id = `q${list.length + 1}`;
    let report: QualityReport;
    try {
      report = finalizeQualityReport(draft, { runId: ctx.runId, nodeId, id, now: ctx.now, adapter: adapterName });
    } catch (e) {
      throw new OpError(`node quality: ${(e as Error).message}`);
    }
    list.push(report);
    added = `quality ${id} recorded for node ${nodeId}: verdict ${report.verdict.value}, ${report.findings.length} findings`;
    return added;
  });
  if (rc === 0) process.stdout.write(added + "\n");
  return rc;
}

async function qualityShow(home: string, args: string[]): Promise<number> {
  const { pos, flags } = parseQualityArgs(args, ["id"]);
  const [runArg = "", nodeId = ""] = pos;
  if (!runArg || !nodeId) throw new Error("usage: node quality show <run> <node> [--id qN]");
  const runId = await resolveRun(home, runArg);
  if (runId === null) return 1;
  const run = await loadRun(home, runId);
  if (!run) throw new Error(`run ${runId}: unknown run`);
  const reports = ((run.quality as QualityReport[] | undefined) ?? []).filter((r) => r.node_id === nodeId && (!flags.id || r.id === flags.id));
  if (reports.length === 0) throw new Error(`node ${nodeId}: no quality reports${flags.id ? ` with id ${flags.id}` : ""}`);
  process.stdout.write(JSON.stringify(reports, null, 2) + "\n");
  return 0;
}

async function qualityList(home: string, args: string[]): Promise<number> {
  const { pos, flags } = parseQualityArgs(args, FILTER_FLAGS);
  const runArg = pos[0] ?? "";
  if (!runArg) throw new Error("usage: node quality list <run> [--node N] [--model M]");
  const runId = await resolveRun(home, runArg);
  if (runId === null) return 1;
  const run = await loadRun(home, runId);
  if (!run) throw new Error(`run ${runId}: unknown run`);
  const reports = filterReports((run.quality as QualityReport[] | undefined) ?? [], flags);
  for (const r of reports) {
    const model = r.model.actual ?? r.model.requested ?? "-";
    const score = r.verdict.score === null ? "-" : String(r.verdict.score);
    const conf = r.confidence === null ? "-" : String(r.confidence);
    process.stdout.write(`${r.id}  ${r.node_id}  ${r.stage}  ${r.skill_id}  ${model}  verdict=${r.verdict.value} score=${score} confidence=${conf} findings=${r.findings.length}\n`);
  }
  return 0;
}

async function qualityExport(home: string, args: string[]): Promise<number> {
  const { pos, flags } = parseQualityArgs(args, FILTER_FLAGS);
  const runArg = pos[0] ?? "";
  if (!runArg) throw new Error("usage: node quality export <run> [--node N] [--model M]");
  const runId = await resolveRun(home, runArg);
  if (runId === null) return 1;
  const run = await loadRun(home, runId);
  if (!run) throw new Error(`run ${runId}: unknown run`);
  const reports = filterReports((run.quality as QualityReport[] | undefined) ?? [], flags);
  process.stdout.write(JSON.stringify({ run_id: runId, ...exportReports(reports, process.env.HOME ?? "") }, null, 2) + "\n");
  return 0;
}
