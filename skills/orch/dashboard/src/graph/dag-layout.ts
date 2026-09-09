import type { RunNode } from "../../../shared/types/run-node";

export const NODE_W: number = 180;
export const NODE_H: number = 56;
export const ORCH_NODE_W: number = 132;
export const ORCH_NODE_H: number = 56;
export const ORCH_NODE_ID: string = "__orch__";
export const GAP_X: number = 80;
export const GAP_Y: number = 24;
export const PAD: number = 24;
export const MIN_SVG_W: number = 320;
export const MIN_SVG_H: number = 120;
export const LABEL_MAX: number = 22;

const ORCH_COL_WIDTH: number = ORCH_NODE_W + GAP_X;

export type DagLayout = {
  pos: Record<string, { x: number; y: number }>;
  orch: { x: number; y: number } | null;
  entryIds: string[];
  width: number;
  height: number;
  cyclic: string[];
};

type LayerAssignment = { layer: Map<string, number>; cyclic: string[] };

/** Dependencies per node id; edges pointing at unknown nodes are ignored. */
function incomingOf(
  nodes: readonly RunNode[],
  edges: readonly [string, string][],
): Map<string, string[]> {
  const incoming = new Map<string, string[]>();
  for (const node of nodes) {
    incoming.set(node.id, []);
  }
  for (const [from, to] of edges) {
    if (!incoming.has(from)) {
      continue;
    }
    incoming.get(to)?.push(from);
  }
  return incoming;
}

/** Assigns `1 + max(layer(dep))` (0 with no deps) once every dep has a layer; otherwise waits. */
function tryAssignLayer(nodeId: string, deps: readonly string[], layer: Map<string, number>): void {
  if (layer.has(nodeId)) {
    return;
  }
  let maxDep = -1;
  for (const dep of deps) {
    const depLayer = layer.get(dep);
    if (depLayer === undefined) {
      return;
    }
    maxDep = Math.max(maxDep, depLayer);
  }
  layer.set(nodeId, maxDep + 1);
}

// layer(n) = 0 with no incoming edge, else 1 + max(layer(dep)). Nodes left unresolved after
// nodes.length passes sit in a cycle: they drop to layer 0 and get a badge.
function assignLayers(nodes: readonly RunNode[], edges: readonly [string, string][]): LayerAssignment {
  const layer = new Map<string, number>();
  const incoming = incomingOf(nodes, edges);
  for (let pass = 0; pass < nodes.length; pass++) {
    for (const node of nodes) {
      tryAssignLayer(node.id, incoming.get(node.id) ?? [], layer);
    }
  }
  const cyclic: string[] = [];
  for (const node of nodes) {
    if (layer.has(node.id)) {
      continue;
    }
    layer.set(node.id, 0);
    cyclic.push(node.id);
  }
  return { layer, cyclic };
}

function columnsOf(nodes: readonly RunNode[], layer: Map<string, number>): Map<number, RunNode[]> {
  const columns = new Map<number, RunNode[]>();
  for (const node of nodes) {
    const col = layer.get(node.id) ?? 0;
    const column = columns.get(col);
    if (column === undefined) {
      columns.set(col, [node]);
      continue;
    }
    column.push(node);
  }
  return columns;
}

/**
 * Longest-path layering, one column per layer, nodes stacked in input order within a column.
 * Pure: the same nodes/edges always give the same geometry, so the graph is stable across polls.
 */
function entryNodeIds(nodes: readonly RunNode[], edges: readonly [string, string][]): string[] {
  const incoming = incomingOf(nodes, edges);
  const ids: string[] = [];
  for (const node of nodes) {
    if ((incoming.get(node.id) ?? []).length === 0) {
      ids.push(node.id);
    }
  }
  return ids;
}

function withOrchColumn(
  pos: Record<string, { x: number; y: number }>,
  width: number,
  height: number,
  entryIds: string[],
): Pick<DagLayout, "orch" | "width"> {
  for (const point of Object.values(pos)) {
    point.x += ORCH_COL_WIDTH;
  }
  const orchY = Math.max(PAD, (height - ORCH_NODE_H) / 2);
  return {
    orch: { x: PAD, y: orchY },
    width: width + ORCH_COL_WIDTH,
  };
}

export function layoutDag(nodes: readonly RunNode[], edges: readonly [string, string][]): DagLayout {
  const { layer, cyclic } = assignLayers(nodes, edges);
  const columns = columnsOf(nodes, layer);
  const pos: Record<string, { x: number; y: number }> = {};
  let maxRows = 0;
  for (const [col, column] of columns) {
    maxRows = Math.max(maxRows, column.length);
    column.forEach((node, row) => {
      pos[node.id] = { x: PAD + col * (NODE_W + GAP_X), y: PAD + row * (NODE_H + GAP_Y) };
    });
  }
  const colCount = columns.size;
  let width = PAD * 2 + colCount * NODE_W + Math.max(0, colCount - 1) * GAP_X;
  let height = PAD * 2 + maxRows * NODE_H + Math.max(0, maxRows - 1) * GAP_Y;
  width = Math.max(width, MIN_SVG_W);
  height = Math.max(height, MIN_SVG_H);

  if (nodes.length === 0) {
    return { pos, orch: null, entryIds: [], width, height, cyclic };
  }

  const entryIds = entryNodeIds(nodes, edges);
  const orchLayout = withOrchColumn(pos, width, height, entryIds);
  return {
    pos,
    orch: orchLayout.orch,
    entryIds,
    width: orchLayout.width,
    height,
    cyclic,
  };
}
