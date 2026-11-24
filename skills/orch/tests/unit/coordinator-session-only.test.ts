import { test, expect, setDefaultTimeout } from "bun:test";
setDefaultTimeout(60000);
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { orch, seedHome, runState, autoCleanup } from "../helpers";
autoCleanup();

// `orchestrator register <run> --session <ses>` from a shell with no terminal (no HERDR_PANE_ID, no HC_TERMINAL_ID).
const noTerminal = { HERDR_PANE_ID: "", HERDR_SOCKET_PATH: "", HC_TERMINAL_ID: "" };

const setup = () => {
  const home = seedHome();
  mkdirSync(join(home, "runs/r1"), { recursive: true });
  writeFileSync(join(home, "runs/r1/state.json"), JSON.stringify({ run_id: "r1", title: "t", status: "running", harness_session: "ses_old", edges: [], nodes: [{ id: "a", status: "running" }] }));
  return { home, o: orch(home, noTerminal) };
};

test("register --session without a terminal records the session as the orchestrator", () => {
  const t = setup();
  const r = t.o("orchestrator", "register", "r1", "--session", "ses_new");
  expect(r.rc).toBe(0);
  expect(r.out).toContain("coordinator: r1 session ses_new");
  const st = runState(t.home, "r1");
  expect(st.harness_session).toBe("ses_new");
  expect([st.coordinator.transport, st.coordinator.session_id, st.coordinator.pane_id, st.coordinator.unreachable]).toEqual(["session", "ses_new", "", null]);
});

test("register without --session and without a terminal still refuses", () => {
  const t = setup();
  const r = t.o("orchestrator", "register", "r1");
  expect(r.rc).toBe(2);
  expect(r.all).toMatch(/HERDR_PANE_ID/);
  expect(runState(t.home, "r1").coordinator ?? null).toBeNull();
});
