/** Run diffs pushed over the run's SSE stream (`event: patch`) and applied to the UI query cache. Bun-free. */

type Doc = Record<string, unknown>;

export interface RunPatch {
  run: string;
  /** Changed top-level run fields (not `nodes`). */
  fields: Doc;
  /** Top-level fields that left the run. */
  unset?: string[];
  /** Per node: the changed fields, whole values. A node new to the run carries all its fields. `unset` lists fields that left the node. */
  nodes: Array<{ id: string; changed: Doc; unset?: string[] }>;
  /** Ids of nodes that left the run. */
  removed: string[];
  /** The edge list, only when it changed. */
  edges?: unknown;
}

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function diffDoc(prev: Doc, next: Doc): { changed: Doc; unset: string[] } {
  const changed: Doc = {};
  for (const key of Object.keys(next)) {
    if (!(key in prev) || !same(prev[key], next[key])) {
      changed[key] = next[key];
    }
  }
  const unset = Object.keys(prev).filter((key) => !(key in next));
  return { changed, unset };
}

function setAll(target: Doc, changed: Doc, unset: string[] | undefined): Doc {
  const out: Doc = { ...target, ...changed };
  for (const key of unset ?? []) {
    delete out[key];
  }
  return out;
}

function nodesOf(run: Doc): Doc[] {
  return Array.isArray(run.nodes) ? (run.nodes as Doc[]) : [];
}

/** The patch that turns `prev` into `next`, or null when nothing changed. */
export function diffRun(runId: string, prev: Doc, next: Doc): RunPatch | null {
  const { nodes: _pn, edges: prevEdges, ...prevRest } = prev;
  const { nodes: _nn, edges: nextEdges, ...nextRest } = next;
  const prevNodes = nodesOf(prev);
  const nextNodes = nodesOf(next);
  const top = diffDoc(prevRest, nextRest);
  const before = new Map(prevNodes.map((n) => [String(n.id), n]));
  const seen = new Set<string>();
  const nodes: RunPatch["nodes"] = [];
  for (const node of nextNodes) {
    const id = String(node.id);
    seen.add(id);
    const old = before.get(id);
    const d = old === undefined ? { changed: node, unset: [] } : diffDoc(old, node);
    if (old === undefined || Object.keys(d.changed).length > 0 || d.unset.length > 0) {
      nodes.push({ id, changed: d.changed, ...(d.unset.length > 0 ? { unset: d.unset } : {}) });
    }
  }
  const removed = [...before.keys()].filter((id) => !seen.has(id));
  const edgesChanged = !same(prevEdges, nextEdges);
  if (Object.keys(top.changed).length === 0 && top.unset.length === 0 && nodes.length === 0 && removed.length === 0 && !edgesChanged) {
    return null;
  }
  return { run: runId, fields: top.changed, ...(top.unset.length > 0 ? { unset: top.unset } : {}), nodes, removed, ...(edgesChanged ? { edges: nextEdges } : {}) };
}

/** Applies a patch to a run document and returns the new one (the input is not changed). */
export function applyRunPatch(run: Doc, patch: RunPatch): Doc {
  const out = setAll(run, patch.fields, patch.unset);
  const byId = new Map(patch.nodes.map((n) => [n.id, n]));
  const kept = nodesOf(run).filter((n) => !patch.removed.includes(String(n.id)));
  const nodes = kept.map((node) => {
    const entry = byId.get(String(node.id));
    if (entry === undefined) {
      return node;
    }
    byId.delete(String(node.id));
    return setAll(node, entry.changed, entry.unset);
  });
  for (const [id, entry] of byId) {
    nodes.push({ ...entry.changed, id });
  }
  out.nodes = nodes;
  if (patch.edges !== undefined) {
    out.edges = patch.edges;
  }
  return out;
}
