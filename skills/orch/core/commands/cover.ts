// `run cover` / `run uncover`: mark a run whose unfinished work was copied into another run as `covered`,
// so it stays neither `error` nor `running`.
import { orchHome } from "../state/home.ts";
import { loadRun } from "../state/store.ts";
import { ev, OpError } from "../runs/node.ts";
import { errLine, mutateRun, resolveRun } from "./node.ts";

export const RUN_COVER_USAGE = 'dispatch.ts run cover <old-run> --by <new-run> [--note "T"] [--map oldNode=newNode ...]';
export const RUN_UNCOVER_USAGE = "dispatch.ts run uncover <run-id>";

/** Nodes of the old run that were not done: the work that was carried. */
export const carriedNodeIds = (nodes: { id?: unknown; status?: unknown }[]): string[] =>
  nodes.filter((n) => n.status !== "done").map((n) => String(n.id));

export async function runCover(args: string[]): Promise<number> {
  const runArg = args[0] ?? "";
  if (!runArg || runArg.startsWith("--")) return (errLine(`usage: ${RUN_COVER_USAGE}`), 2);
  let by = "";
  let note = "";
  const pairs: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--by") by = args[++i] ?? "";
    else if (a === "--note") note = args[++i] ?? "";
    else if (a === "--map") pairs.push(args[++i] ?? "");
    else return (errLine(`run cover: unknown argument ${a}\n  usage: ${RUN_COVER_USAGE}`), 2);
  }
  if (!by || by.startsWith("--")) return (errLine(`run cover: --by <new-run> is required\n  usage: ${RUN_COVER_USAGE}`), 2);
  const home = orchHome();
  const oldId = await resolveRun(home, runArg);
  if (oldId === null) return 1;
  const newId = await resolveRun(home, by);
  if (newId === null) return 1;
  if (oldId === newId) return (errLine("run cover: a run cannot be covered by itself"), 2);
  const target = await loadRun(home, newId);
  if (!target) return (errLine(`run ${newId}: unknown run`), 2);
  const map: Record<string, string> = {};
  for (const p of pairs) {
    const eq = p.indexOf("=");
    if (eq < 1 || eq === p.length - 1) return (errLine(`run cover: --map expects oldNode=newNode, got "${p}"`), 2);
    map[p.slice(0, eq)] = p.slice(eq + 1);
  }
  const rc = await mutateRun(home, oldId, (r, ctx) => {
    for (const [o, n] of Object.entries(map)) {
      if (!r.nodes.some((x) => x.id === o)) throw new OpError(`run cover: node ${o} is not in ${oldId}`);
      if (!target.nodes.some((x) => x.id === n)) throw new OpError(`run cover: node ${n} is not in ${newId}`);
    }
    if (r.status !== "covered") r.covered_prev_status = r.status;
    r.status = "covered";
    r.finished = r.finished ?? ctx.now;
    r.covered_by = newId;
    r.covered_at = ctx.now;
    r.covered_note = note;
    r.covered_nodes = carriedNodeIds(r.nodes);
    r.covered_map = map;
    ev(ctx, "run", "", "", "covered", `by ${newId}`);
  });
  if (rc === 0) process.stdout.write(`covered: ${oldId} by ${newId}\n`);
  return rc;
}

export async function runUncover(args: string[]): Promise<number> {
  const runArg = args[0] ?? "";
  if (!runArg || args.length !== 1) return (errLine(`usage: ${RUN_UNCOVER_USAGE}`), 2);
  const home = orchHome();
  const id = await resolveRun(home, runArg);
  if (id === null) return 1;
  let to = "";
  const rc = await mutateRun(home, id, (r, ctx) => {
    if (r.status !== "covered") throw new OpError(`run uncover: ${id} is not covered (status ${r.status})`);
    const prev = String(r.covered_prev_status ?? "");
    to = prev && prev !== "covered" ? prev : r.nodes.some((n) => n.status === "error") ? "error" : "done";
    r.status = to;
    if (to === "running") r.finished = null;
    for (const k of ["covered_by", "covered_at", "covered_note", "covered_nodes", "covered_map", "covered_prev_status"]) delete r[k];
    ev(ctx, "run", "", "covered", to, "uncovered");
  });
  if (rc === 0) process.stdout.write(`${to}: ${id}\n`);
  return rc;
}

export const NODE_REPLACE_USAGE = "dispatch.ts node replace <run-id> <node-id> [--run <new-run>]";

export async function nodeReplace(args: string[]): Promise<number> {
  if (args.length < 2) {
    return (errLine(`usage: ${NODE_REPLACE_USAGE}`), 2);
  }
  const runArg = args[0];
  const nodeId = args[1];
  if (!runArg || !nodeId || runArg.startsWith("--") || nodeId.startsWith("--")) {
    return (errLine(`usage: ${NODE_REPLACE_USAGE}`), 2);
  }
  let target = "";
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--run") target = args[++i] ?? "";
    else return (errLine(`node replace: unknown argument ${args[i]}\n  usage: ${NODE_REPLACE_USAGE}`), 2);
  }
  const home = orchHome();
  const oldId = await resolveRun(home, runArg);
  if (oldId === null) return 1;
  const old = await loadRun(home, oldId);
  if (!old) return (errLine(`run ${oldId}: unknown run`), 2);
  const src = old.nodes.find((x) => x.id === nodeId);
  if (!src) return (errLine(`node replace: node ${nodeId} is not in ${oldId}`), 2);
  if (src.status === "covered") return (errLine(`node replace: ${nodeId} is already covered`), 2);
  let newRun = oldId;
  if (target !== "") {
    const resolved = await resolveRun(home, target);
    if (resolved === null) return 1;
    newRun = resolved;
  }
  const dst = await loadRun(home, newRun);
  if (!dst) return (errLine(`run ${newRun}: unknown run`), 2);
  let newId = `${nodeId}-r2`;
  for (let k = 2; dst.nodes.some((x) => x.id === newId); k++) newId = `${nodeId}-r${k + 1}`;
  const fresh: Record<string, unknown> = {
    ...structuredClone(src),
    id: newId,
    status: "waiting",
    owner: null,
    owner_kind: null,
    owner_id: null,
    owner_state: null,
    job_id: null,
    started: null,
    finished: null,
    error: null,
    result: null,
    handoff_reason: null,
    result_reason: null,
    unverified: null,
    auto: null,
    next_retry_at: null,
    log_tail: null,
    cost: null,
    attempts: [],
    covered_by: null,
    covered_at: null,
    replaces: `${oldId}/${nodeId}`,
  };
  if (newRun === oldId) fresh.after = Array.isArray(src.after) ? src.after.filter((d: string) => d !== nodeId) : [];
  else fresh.after = [];
  await mutateRun(home, newRun, (r, ctx) => {
    r.nodes.push(fresh as never);
    ev(ctx, "note", newId, "", "", `replaces ${oldId}/${nodeId}`);
  });
  const rc = await mutateRun(home, oldId, (r, ctx) => {
    const replacement = r.nodes.find((x) => x.id === nodeId);
    if (!replacement) throw new OpError(`node replace: node ${nodeId} is not in ${oldId}`);
    replacement.status = "covered";
    replacement.covered_by = `${newRun}/${newId}`;
    replacement.covered_at = ctx.now;
    replacement.finished = replacement.finished ?? ctx.now;
    ev(ctx, "status", nodeId, src.status ?? "", "covered", `by ${newRun}/${newId}`);
  });
  if (rc === 0) process.stdout.write(`covered: ${oldId}/${nodeId} by ${newRun}/${newId}\n`);
  return rc;
}
