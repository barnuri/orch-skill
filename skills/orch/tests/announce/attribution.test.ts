// A session shows orch activity only when it is part of a run (coordinator or node owner).
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attributed, scan } from "../../core/commands/announce.ts";
import { autoCleanup, tempDir } from "../helpers/index.ts";

autoCleanup();

function homeWith(run: Record<string, unknown>, extra: { watches?: Record<string, unknown> } = {}): string {
  const home = tempDir("orch-announce-");
  mkdirSync(join(home, "runs", "r1"), { recursive: true });
  writeFileSync(join(home, "runs", "r1", "state.json"), JSON.stringify({ status: "running", ...run }));
  for (const [id, w] of Object.entries(extra.watches ?? {})) {
    mkdirSync(join(home, "watches", id), { recursive: true });
    writeFileSync(join(home, "watches", id, "state.json"), JSON.stringify(w));
  }
  return home;
}

const nodes = [{ id: "a", status: "running" }, { id: "b", status: "done" }];

test("a session that is not the coordinator or an owner sees nothing, even while a run is running", () => {
  const home = homeWith({ nodes, coordinator: { session_id: "ses_other", pane_id: "w1:p1" } });
  expect(scan(home, "", "ses_me", "w9:p9")).toEqual({ running: 0, done: 0, total: 0, loops: 0, watches: 0 });
});

test("the coordinator session, the coordinator pane and a node owner are attributed", () => {
  const coordinator = { session_id: "ses_coord", pane_id: "w1:p1" };
  const home = homeWith({ nodes: [{ id: "a", status: "running", owner_id: "ses_owner" }, { id: "b", status: "done" }], coordinator });
  expect(scan(home, "", "ses_coord", "").running).toBe(1);
  expect(scan(home, "", "x", "w1:p1").done).toBe(1);
  expect(scan(home, "", "ses_owner", "").total).toBe(2);
});

test("an explicit run id always counts; another run id does not", () => {
  const s = { nodes, coordinator: {} };
  expect(attributed(s, "r1", "r1", "", "")).toBe(true);
  expect(attributed(s, "r1", "r2", "", "")).toBe(false);
});

test("a stray monitor does not make an unrelated session look like orch", () => {
  const home = homeWith({ nodes, coordinator: { session_id: "ses_other" } }, { watches: { w1: { status: "running", pid: process.pid } } });
  const r = scan(home, "", "ses_me", "");
  expect(r.watches).toBe(0);
  expect(r.running).toBe(0);
});
