import { test, expect, setDefaultTimeout } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { orch, tempDir, fakeBin, autoCleanup } from "../helpers";
import { runHome } from "./common";
setDefaultTimeout(120000);
autoCleanup();

const herdrEnv = () => {
  const dir = tempDir("orch-gap7-");
  const sock = join(dir, "s.sock");
  writeFileSync(sock, "");
  const bin = fakeBin({ herdr: `echo '{}'` });
  return { PATH: `${bin}:${process.env.PATH}`, HERDR_PANE_ID: "p-1", HERDR_SOCKET_PATH: sock, HERDR_WORKSPACE_ID: "ws-1", ORCH_HERDR: "0", ORCH_COORD_SETTLE_SECS: "0" };
};

test("use <run> records the coordinator", () => {
  const t = runHome();
  const o = orch(t.home, herdrEnv());
  expect(o("use", "r1").rc).toBe(0);
  expect(t.st().coordinator?.pane_id).toBe("p-1");
});

test("the first run wait records the coordinator", () => {
  const t = runHome();
  const o = orch(t.home, { ...herdrEnv(), ORCH_WAIT_POLL_SECS: "1", ORCH_WAIT_HEALTH_SECS: "3600" });
  o("run", "wait", "r1", "--timeout", "3");
  expect(t.st().coordinator?.pane_id).toBe("p-1");
});
