import { describe, expect, test } from "bun:test";

import { FOLLOW_SCALE, READABLE_FIT, followView } from "./follow-view";

const base = { viewportW: 800, viewportH: 500, graphW: 4000, graphH: 1200, fitScale: 0.2 };
const box = (x: number, y: number) => ({ x, y, w: 200, h: 74 });

describe("followView", () => {
  test("a graph that fits at a readable size stays fitted and does not scroll", () => {
    const view = followView({ ...base, graphW: 900, graphH: 400, fitScale: 0.9, boxes: [box(700, 300)] });
    expect(view).toEqual({ scale: 0.9, left: 0, top: 0, fitsAll: true });
  });

  test("the readable threshold is exactly where following starts", () => {
    expect(followView({ ...base, fitScale: READABLE_FIT, boxes: [box(3000, 0)] }).fitsAll).toBe(true);
    expect(followView({ ...base, fitScale: READABLE_FIT - 0.01, boxes: [box(3000, 0)] }).fitsAll).toBe(false);
  });

  test("a large graph is zoomed to a readable scale and centered on the focus", () => {
    const view = followView({ ...base, boxes: [box(2000, 500)] });
    expect(view.scale).toBe(FOLLOW_SCALE);
    // centre of the box is x=2100, y=537 → screen 1890, 483.3; minus half the viewport.
    expect(view.left).toBeCloseTo(2100 * FOLLOW_SCALE - 400, 5);
    expect(view.top).toBeCloseTo(537 * FOLLOW_SCALE - 250, 5);
    expect(view.fitsAll).toBe(false);
  });

  test("the offsets never scroll past the edges of the graph", () => {
    const start = followView({ ...base, boxes: [box(0, 0)] });
    expect(start.left).toBe(0);
    expect(start.top).toBe(0);
    const end = followView({ ...base, boxes: [box(3800, 1126)] });
    expect(end.left).toBe(base.graphW * FOLLOW_SCALE - base.viewportW);
    expect(end.top).toBe(base.graphH * FOLLOW_SCALE - base.viewportH);
  });

  test("focused nodes that fit on screen together are centered together", () => {
    const view = followView({ ...base, boxes: [box(2000, 500), box(2300, 500)] });
    // together they span x 2000..2500, centre 2250.
    expect(view.left).toBeCloseTo(2250 * FOLLOW_SCALE - 400, 5);
  });

  test("focused nodes too far apart to fit fall back to the primary one", () => {
    const view = followView({ ...base, boxes: [box(2000, 500), box(200, 500)] });
    expect(view.left).toBeCloseTo(2100 * FOLLOW_SCALE - 400, 5);
  });

  test("with nothing to focus it just fits", () => {
    expect(followView({ ...base, boxes: [] }).fitsAll).toBe(true);
  });

  test("a graph smaller than the viewport never produces a negative offset", () => {
    const view = followView({ viewportW: 2000, viewportH: 1000, graphW: 900, graphH: 400, fitScale: 0.5, boxes: [box(700, 300)] });
    expect(view.left).toBe(0);
    expect(view.top).toBe(0);
  });
});
