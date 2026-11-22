import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { tempDir, readText, runCmd, DISPATCH, autoCleanup, fakeBin } from "../helpers";
autoCleanup();

// Announce with a fake herdr, one run whose state is seeded by the test (same setup as announce-idle).
const mk = () => {
  const T = tempDir(), H = join(T, "home"), O = join(T, "orch");
  mkdirSync(H, { recursive: true }); mkdirSync(O, { recursive: true });
  const fake = fakeBin({ herdr: "exit 0" });
  const env = { HOME: H, HARNESS_ORCH_HOME: O, HERDR_ENV: "1", HERDR_PANE_ID: "p1", HERDR_BIN_PATH: join(fake, "herdr"), CLAUDE_CODE_SESSION_ID: "sess1", ANNOUNCE_NO_DAEMON: "1", ORCH_NO_ANNOUNCE: undefined as any };
  const ann = (...a: string[]) => runCmd(["bun", DISPATCH, "announce", ...a], { env });
  const seed = (nodes: any[]) => {
    mkdirSync(join(O, "runs/r1"), { recursive: true });
    writeFileSync(join(O, "runs/r1/state.json"), JSON.stringify({ run_id: "r1", status: "running", coordinator: { session_id: "sess1" }, nodes }));
  };
  const activity = () => JSON.parse(readText(join(O, "activity/sess1.json")));
  return { ann, seed, activity };
};

test("announce: a run waiting on a ready gate is active, not idle", () => {
  const t = mk();
  t.seed([{ id: "a", status: "done" }, { id: "done-gate", status: "waiting", after_all: true }]);
  expect(t.ann("--quiet").rc).toBe(0);
  const j = t.activity();
  expect(j.active).toBe(true);
  expect(j.summary).toBe("orch: 0 running, 1/2 done · 1 gate ready");
});

test("announce: a gate behind a node that is not terminal does not count", () => {
  const t = mk();
  t.seed([{ id: "a", status: "waiting" }, { id: "done-gate", status: "waiting", after_all: true }]);
  t.ann("--quiet");
  expect(t.activity().active).toBe(false);
});
