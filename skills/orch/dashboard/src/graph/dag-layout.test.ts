import { describe, expect, test } from "bun:test";

import type { RunNode } from "../../../shared/types/run-node";
import {
  GAP_X,
  GAP_Y,
  MIN_SVG_H,
  MIN_SVG_W,
  NODE_H,
  NODE_W,
  PAD,
  layoutDag,
} from "./dag-layout.ts";

function node(id: string): RunNode {
  return {
    id,
    label: id,
    status: "waiting",
    profile: null,
    adapter: null,
    job_id: null,
    started: null,
    finished: null,
    error: null,
    log_tail: [],
  };
}

describe("layoutDag", () => {
  test("an empty run still gets a minimum canvas", () => {
    const layout = layoutDag([], []);
    expect(layout.pos).toEqual({});
    expect(layout.cyclic).toEqual([]);
    expect(layout.width).toBe(MIN_SVG_W);
    expect(layout.height).toBe(MIN_SVG_H);
  });

  // The pinned 3-node fixture: a → b, a → c. One dependency column, two parallel nodes.
  test("a fan-out puts the dependency left and its children stacked right", () => {
    const layout = layoutDag(
      [node("a"), node("b"), node("c")],
      [
        ["a", "b"],
        ["a", "c"],
      ],
    );
    expect(layout.pos.a).toEqual({ x: PAD, y: PAD });
    expect(layout.pos.b).toEqual({ x: PAD + NODE_W + GAP_X, y: PAD });
    expect(layout.pos.c).toEqual({ x: PAD + NODE_W + GAP_X, y: PAD + NODE_H + GAP_Y });
    expect(layout.cyclic).toEqual([]);
    expect(layout.width).toBe(PAD * 2 + 2 * NODE_W + GAP_X);
    expect(layout.height).toBe(PAD * 2 + 2 * NODE_H + GAP_Y);
  });

  // Longest path, not shortest: c depends on both a and b, so it sits in column 2 even though
  // one of its dependencies (a) is in column 0.
  test("a node lands one column past its deepest dependency", () => {
    const layout = layoutDag(
      [node("a"), node("b"), node("c")],
      [
        ["a", "b"],
        ["a", "c"],
        ["b", "c"],
      ],
    );
    expect(layout.pos.a?.x).toBe(PAD);
    expect(layout.pos.b?.x).toBe(PAD + NODE_W + GAP_X);
    expect(layout.pos.c?.x).toBe(PAD + 2 * (NODE_W + GAP_X));
    // Each column holds one node, so nothing stacks.
    expect(layout.pos.c?.y).toBe(PAD);
  });

  test("independent nodes stack in input order in one column", () => {
    const layout = layoutDag([node("x"), node("y")], []);
    expect(layout.pos.x).toEqual({ x: PAD, y: PAD });
    expect(layout.pos.y).toEqual({ x: PAD, y: PAD + NODE_H + GAP_Y });
  });

  // A cycle cannot be layered; those nodes drop to column 0 and are reported for a badge
  // instead of hanging the layout or throwing.
  test("a cycle is reported and still positioned", () => {
    const layout = layoutDag(
      [node("a"), node("b")],
      [
        ["a", "b"],
        ["b", "a"],
      ],
    );
    expect(layout.cyclic.slice().sort()).toEqual(["a", "b"]);
    expect(layout.pos.a).toBeDefined();
    expect(layout.pos.b).toBeDefined();
  });

  test("a node inside a cycle does not drag an acyclic node down with it", () => {
    const layout = layoutDag(
      [node("ok"), node("a"), node("b")],
      [
        ["a", "b"],
        ["b", "a"],
      ],
    );
    expect(layout.cyclic.slice().sort()).toEqual(["a", "b"]);
    expect(layout.pos.ok).toEqual({ x: PAD, y: PAD });
  });

  test("edges pointing at unknown nodes are ignored", () => {
    const layout = layoutDag([node("a")], [["ghost", "a"]]);
    expect(layout.pos.a).toEqual({ x: PAD, y: PAD });
    expect(layout.cyclic).toEqual([]);
  });

  // Stability matters: the graph re-renders every 2 s poll and must not jitter.
  test("the same input always gives the same geometry", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const edges: [string, string][] = [
      ["a", "b"],
      ["b", "c"],
    ];
    expect(layoutDag(nodes, edges)).toEqual(layoutDag(nodes, edges));
  });
});
