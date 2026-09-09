import type { RunNode } from "../../../shared/types/run-node";

export const NODE_W: number = 180;
export const NODE_H: number = 56;
export const GAP_X: number = 80;
export const GAP_Y: number = 24;
export const PAD: number = 24;
export const MIN_SVG_W: number = 320;
export const MIN_SVG_H: number = 120;
export const LABEL_MAX: number = 22;

export type DagLayout = {
  pos: Record<string, { x: number; y: number }>;
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
  const width = PAD * 2 + colCount * NODE_W + Math.max(0, colCount - 1) * GAP_X;
  const height = PAD * 2 + maxRows * NODE_H + Math.max(0, maxRows - 1) * GAP_Y;
  return { pos, width: Math.max(width, MIN_SVG_W), height: Math.max(height, MIN_SVG_H), cyclic };
}
