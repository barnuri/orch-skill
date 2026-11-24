// `feedback add` dedup (R10): one open item per run+node, or per normalized text when no run/node.
import { test, expect } from "bun:test";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { orch, seedHome, readJson, autoCleanup } from "../helpers";
autoCleanup();

const items = (home: string): any[] =>
  readdirSync(join(home, "feedback")).filter((f) => f.endsWith(".json")).map((f) => readJson(join(home, "feedback", f)));

test("same run and node: the second add becomes a note on the open item and prints its id", () => {
  const home = seedHome();
  const o = orch(home);
  const a = o("feedback", "add", "first text", "--run", "r1", "--node", "n1");
  expect(a.rc).toBe(0);
  const b = o("feedback", "add", "second text", "--run", "r1", "--node", "n1");
  expect(b.rc).toBe(0);
  expect(b.out.trim()).toBe(a.out.trim());
  const all = items(home);
  expect(all).toHaveLength(1);
  expect(all[0].text).toBe("first text");
  expect(all[0].notes.map((n: any) => n.text)).toEqual(["second text"]);
});

test("no run or node: the same normalized text merges, other text is a new item", () => {
  const home = seedHome();
  const o = orch(home);
  const a = o("feedback", "add", "Run list  is slow");
  const b = o("feedback", "add", "  run LIST is slow ");
  expect(b.out.trim()).toBe(a.out.trim());
  const c = o("feedback", "add", "Another thing");
  expect(c.out.trim()).not.toBe(a.out.trim());
  const all = items(home);
  expect(all).toHaveLength(2);
  expect(all.find((i) => i.id === a.out.trim()).notes).toHaveLength(1);
});

test("a different node in the same run gets a new item", () => {
  const home = seedHome();
  const o = orch(home);
  const a = o("feedback", "add", "same text", "--run", "r1", "--node", "n1");
  const b = o("feedback", "add", "same text", "--run", "r1", "--node", "n2");
  expect(b.out.trim()).not.toBe(a.out.trim());
  expect(items(home)).toHaveLength(2);
});

test("a closed item does not absorb a new add", () => {
  const home = seedHome();
  const o = orch(home);
  const a = o("feedback", "add", "x", "--run", "r1", "--node", "n1").out.trim();
  expect(o("feedback", "update", a, "--status", "done").rc).toBe(0);
  const b = o("feedback", "add", "x again", "--run", "r1", "--node", "n1").out.trim();
  expect(b).not.toBe(a);
  expect(items(home)).toHaveLength(2);
});
