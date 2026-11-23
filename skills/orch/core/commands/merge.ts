import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLock } from "../state/lock.ts";
import { orchHome, paths } from "../state/home.ts";
import { appendEvents, loadRun, saveRun, writeJsonAtomic } from "../state/store.ts";
import { resolveRun, errLine } from "./node.ts";
import { reqFile, type Ledger } from "./req.ts";
import { ownerSafe } from "./owners.ts";

export const RUN_MERGE_USAGE = "dispatch.ts run merge <source-run> <destination-run> [--nodes id,id]";

function readLedger(home: string, runId: string): Ledger {
  const file = reqFile(home, runId);
  if (!existsSync(file)) return { requirements: [] };
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Ledger;
    return { requirements: Array.isArray(value.requirements) ? value.requirements : [] };
  } catch {
    return { requirements: [] };
  }
}

function parseNodes(args: string[]): { nodes: Set<string> | null; error: string } {
  let nodes: Set<string> | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--nodes" || arg === "--node") {
      const value = args[++i] ?? "";
      if (!value || value.startsWith("--")) return { nodes: null, error: `${arg} expects a comma-separated node id list` };
      nodes = new Set(value.split(/[,\s]+/).filter(Boolean));
      if (nodes.size === 0) return { nodes: null, error: `${arg} expects a comma-separated node id list` };
    } else {
      return { nodes: null, error: `run merge: unknown argument ${arg}` };
    }
  }
  return { nodes, error: "" };
}

export async function runMerge(args: string[]): Promise<number> {
  const home = orchHome();
  const sourceArg = args[0] ?? "";
  const destinationArg = args[1] ?? "";
  if (!sourceArg || !destinationArg) {
    errLine(`usage: ${RUN_MERGE_USAGE}`);
    return 2;
  }
  const sourceId = await resolveRun(home, sourceArg);
  const destinationId = await resolveRun(home, destinationArg);
  if (sourceId === null || destinationId === null) return 2;
  if (sourceId === destinationId) {
    errLine("run merge: source and destination must differ");
    return 2;
  }
  const parsed = parseNodes(args.slice(2));
  if (parsed.error) {
    errLine(`${parsed.error}\n  usage: ${RUN_MERGE_USAGE}`);
    return 2;
  }

  const source = await loadRun(home, sourceId);
  const destination = await loadRun(home, destinationId);
  if (!source) {
    errLine(`run ${sourceId}: unknown run`);
    return 2;
  }
  if (!destination) {
    errLine(`run ${destinationId}: unknown run`);
    return 2;
  }

  const selected = parsed.nodes
    ? parsed.nodes
    : new Set(source.nodes.map((node) => String(node.id)));
  const missing = [...selected].filter((id) => !source.nodes.some((node) => String(node.id) === id));
  if (missing.length > 0) {
    errLine(`run merge: node(s) not in source run ${sourceId}: ${missing.join(",")}`);
    return 2;
  }
  const destinationIds = new Set(destination.nodes.map((node) => String(node.id)));
  const duplicate = [...selected].filter((id) => destinationIds.has(id));
  if (duplicate.length > 0) {
    errLine(`run merge: node(s) already in destination run ${destinationId}: ${duplicate.join(",")}`);
    return 2;
  }

  const ordered = [sourceId, destinationId].sort();
  const runLocks = [];
  for (const runId of ordered) {
    const lock = await acquireLock(home, `run-${runId}`, 600, 50);
    if (!lock) {
      for (const held of runLocks) await held.release();
      errLine(`run ${runId}: state is locked by another writer`);
      return 75;
    }
    runLocks.push(lock);
  }

  const reqLocks = [];
  try {
    for (const runId of ordered) {
      const lock = await acquireLock(home, `req-${runId}`, 400, 50);
      if (!lock) {
        errLine(`run ${runId}: requirements are locked by another writer`);
        return 75;
      }
      reqLocks.push(lock);
    }

    const sourceNow = await loadRun(home, sourceId);
    const destinationNow = await loadRun(home, destinationId);
    if (!sourceNow || !destinationNow) {
      errLine("run merge: a run changed during merge");
      return 75;
    }

    const moved = sourceNow.nodes.filter((node) => selected.has(String(node.id))).map((node) => {
      const clone = structuredClone(node);
      if ((clone.out_dir ?? "") === "") {
        const existingOutDir = join(paths.runs(home), sourceId, "out", String(clone.id));
        if (existsSync(existingOutDir)) clone.out_dir = existingOutDir;
      }
      return clone;
    });
    sourceNow.nodes = sourceNow.nodes.filter((node) => !selected.has(String(node.id)));

    const sourceEdges = (sourceNow.edges ?? []).map((edge: string[]) => [...edge]);
    sourceNow.edges = sourceEdges.filter((edge: string[]) =>
      !selected.has(String(edge[0])) && !selected.has(String(edge[1])));

    destinationNow.nodes = [...destinationNow.nodes, ...moved];
    const movedEdgePairs = sourceEdges;
    for (const edge of movedEdgePairs) {
      if (!selected.has(String(edge[0])) || !selected.has(String(edge[1]))) continue;
      if (!(destinationNow.edges ?? []).some((item: string[]) => item[0] === edge[0] && item[1] === edge[1])) {
        destinationNow.edges = destinationNow.edges ?? [];
        destinationNow.edges.push([edge[0], edge[1]]);
      }
    }

    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const sourceLedger = readLedger(home, sourceId);
    const destinationLedger = readLedger(home, destinationId);
    const destinationIdsInLedger = new Set(destinationLedger.requirements.map((req) => req.id));
    const duplicateRequirements = sourceLedger.requirements
      .filter((req) => destinationIdsInLedger.has(req.id))
      .map((req) => req.id);
    if (duplicateRequirements.length > 0) {
      errLine(`run merge: requirement id(s) already exist in destination: ${duplicateRequirements.join(",")}`);
      return 2;
    }

    const movedRequirements = [];
    const remainingRequirements = [];
    for (const requirement of sourceLedger.requirements) {
      const links = requirement.nodes ?? [];
      const movedLinks = links.filter((id) => selected.has(id));
      if (parsed.nodes && movedLinks.length === 0) {
        remainingRequirements.push(requirement);
        continue;
      }
      if (!parsed.nodes) {
        movedRequirements.push(requirement);
        continue;
      }
      const remainingLinks = links.filter((id) => !selected.has(id));
      if (remainingLinks.length > 0) {
        remainingRequirements.push({ ...requirement, nodes: remainingLinks, updated: now });
      }
      movedRequirements.push({ ...requirement, nodes: movedLinks, updated: now });
    }

    destinationLedger.requirements = [...destinationLedger.requirements, ...movedRequirements];

    await saveRun(home, sourceId, sourceNow);
    await saveRun(home, destinationId, destinationNow);

    mkdirSync(join(paths.runs(home), sourceId), { recursive: true });
    mkdirSync(join(paths.runs(home), destinationId), { recursive: true });
    await writeJsonAtomic(reqFile(home, sourceId), { requirements: remainingRequirements });
    await writeJsonAtomic(reqFile(home, destinationId), destinationLedger);

    const ownerUpdates: Array<{ id: string; node: string }> = [];
    for (const node of moved) {
      if (typeof node.owner_id === "string" && node.owner_id !== "") {
        ownerUpdates.push({ id: node.owner_id, node: String(node.id) });
      }
    }
    const ownerDir = join(home, "owners");
    mkdirSync(ownerDir, { recursive: true });
    for (const owner of ownerUpdates) {
      const file = join(ownerDir, `${ownerSafe(owner.id)}.json`);
      let body: Record<string, unknown> = {};
      if (existsSync(file)) {
        try { body = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; } catch { body = {}; }
      }
      body.run = destinationId;
      body.node = owner.node;
      await Bun.write(file, JSON.stringify(body) + "\n");
    }

    await appendEvents(home, sourceId, [{ at: now, by: "run-merge", kind: "node", node: "", from: "", to: "", note: `merged ${moved.length} node(s) into ${destinationId}` }]);
    await appendEvents(home, destinationId, [{ at: now, by: "run-merge", kind: "node", node: "", from: "", to: "", note: `received ${moved.length} node(s) from ${sourceId}` }]);

    process.stdout.write(`merged ${moved.length} node(s) from ${sourceId} to ${destinationId}\n`);
    return 0;
  } finally {
    for (const lock of reqLocks.reverse()) await lock.release();
    for (const lock of runLocks.reverse()) await lock.release();
  }
}
