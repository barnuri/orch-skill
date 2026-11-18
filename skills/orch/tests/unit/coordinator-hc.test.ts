import { test, expect, setDefaultTimeout } from "bun:test";
setDefaultTimeout(120000);
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { orch, seedHome, tempDir, fakeBin, editJson, runState, autoCleanup } from "../helpers";
autoCleanup();

// Fake hc: ls --json [--label k=v] lists $FAKE_HC_LS, get --json t answers state, send logs the text, label logs.
const FAKE = `#!/bin/sh
echo "$*" >> "$FAKE_LOG"
case "$1" in
ls) cat "$FAKE_HC_LS" ;;
get) [ -e "$FAKE_FLAGS/gone_$3" ] && exit 1; echo '{"address":"'$3'","state":"live","status":null}' ;;
send) [ -e "$FAKE_FLAGS/send_fail" ] && exit 1; printf '%s\\n' "$3" >> "$FAKE_TEXT" ;;
label) ;;
esac
exit 0
`;

const setup = () => {
  const home = seedHome();
  const dir = tempDir("orch-hc-");
  const flags = join(dir, "flags"); mkdirSync(flags);
  const fake = fakeBin({ hc: FAKE });
  const log = join(dir, "log"), text = join(dir, "text"), ls = join(dir, "ls.json");
  writeFileSync(log, ""); writeFileSync(text, ""); writeFileSync(ls, JSON.stringify({ terminals: [] }));
  const home2 = join(dir, "home"); mkdirSync(home2);
  const env = { PATH: `${fake}:${process.env.PATH}`, FAKE_LOG: log, FAKE_TEXT: text, FAKE_FLAGS: flags, FAKE_HC_LS: ls, ORCH_OWNER_INDEX: "0", ORCH_HERDR: "0", HOME: home2, HC_TERMINAL_ID: "t1t", ORCH_COORD_SESSION: "ses_H", HERDR_PANE_ID: "", HERDR_SOCKET_PATH: "" };
  const o = orch(home, env);
  mkdirSync(join(home, "runs/r1"), { recursive: true });
  writeFileSync(join(home, "runs/r1/state.json"), JSON.stringify({ run_id: "r1", title: "t", status: "running", edges: [], nodes: [{ id: "a", status: "running" }] }));
  const terminals = (...ts: object[]) => writeFileSync(ls, JSON.stringify({ terminals: ts }));
  return { home, o, dir, flags, terminals, st: () => runState(home, "r1"), text: () => require("node:fs").readFileSync(text, "utf8"), log: () => require("node:fs").readFileSync(log, "utf8") };
};

test("register records hc coordinator and labels it; ask is delivered with hc send", () => {
  const t = setup();
  expect(t.o("coordinator", "register", "r1").rc).toBe(0);
  const c = t.st().coordinator;
  expect([c.transport, c.pane_id, c.session_id, c.socket_path]).toEqual(["hc", "t1t", "ses_H", "hc"]);
  expect(t.log()).toMatch(/label t1t orch\.coordinator=ses_H/);
  t.o("node", "ask", "r1", "a", "hc question");
  expect(t.text()).toMatch(/^\[orch ask #m\d+ from a\] hc question/);
  expect(t.log()).toMatch(/send t1t \[orch ask/);
});

test("gone hc terminal: repoint by label, then by agent+cwd candidates; UI repoint works", () => {
  const t = setup();
  t.o("coordinator", "register", "r1");
  editJson(join(t.home, "runs/r1/state.json"), (s: any) => { s.coordinator.harness = "opencode"; s.coordinator.repo = "/w"; });
  writeFileSync(join(t.flags, "gone_t1t"), "1");
  t.terminals({ address: "t9", agent: "opencode", cwd: "/w", state: "live", labels: { "orch.coordinator": "ses_H" } });
  t.o("node", "ask", "r1", "a", "after failover");
  expect([t.st().coordinator.pane_id, t.st().coordinator.last_repoint.reason, t.st().coordinator.transport]).toEqual(["t9", "same session", "hc"]);
  expect(t.text()).toMatch(/after failover/);
  // two agent+cwd matches, no label -> candidates, then user picks
  writeFileSync(join(t.flags, "gone_t9"), "1");
  t.terminals({ address: "t5", agent: "opencode", cwd: "/w", state: "live", labels: {} }, { address: "t6", agent: "opencode", cwd: "/w", state: "live", labels: {} });
  t.o("node", "ask", "r1", "a", "second");
  const c = t.st().coordinator;
  expect([c.unreachable.reason, c.candidates.map((x: any) => x.pane_id)]).toEqual(["pane or socket gone", ["t5", "t6"]]);
  expect(t.o("run", "repoint", "r1", "hc", "t6").out).toMatch(/repointed: r1 t6/);
  expect(t.o("run-util", "sweep", "r1").out).toMatch(/swept 1/);
  expect(t.text()).toMatch(/second/);
  expect(t.st().coordinator.transport).toBe("hc");
});
