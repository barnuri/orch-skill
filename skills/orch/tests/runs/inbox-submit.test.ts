import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { orch, seedHome, fakeBin, tempDir, readJson, autoCleanup } from "../helpers";
autoCleanup();

test("a message left in the pane input is not delivered; it stays pending and is not typed twice", () => {
  const home = seedHome();
  const log = join(tempDir(), "calls.log");
  writeFileSync(log, "");
  const stuck = `printf '%s\\n' "$*" >> "$ORCH_HERDR_FAKE_LOG"; case "$*" in *"send-text"*) : > "$ORCH_HERDR_FAKE_LOG.typed" ;; *"pane read"*) [ -e "$ORCH_HERDR_FAKE_LOG.typed" ] && printf '%s\\n' '> [orch message m1 from orch] stop editing' ;; esac`;
  const fake = fakeBin({ herdr: stuck });
  const oh = orch(home, { ORCH_HERDR: "1", PATH: `${fake}:${process.env.PATH}`, ORCH_HERDR_FAKE_LOG: log });
  oh("run", "start", "Submit test", "--id", "sub-1");
  oh("node", "add", "sub-1", "a", "pane node");
  mkdirSync(join(home, "jobs/job-a"), { recursive: true });
  writeFileSync(join(home, "jobs/job-a/herdr_pane"), "w1:p7\n");
  oh("node", "update", "sub-1", "a", "running", "--job", "job-a");

  const r = oh("node", "tell", "sub-1", "a", "stop editing");
  expect(r.out).toMatch(/^m1 a pending$/m);
  const calls = readFileSync(log, "utf8");
  expect(calls).toMatch(/^pane send-text w1:p7 \[orch message m1 from orch\] stop editing$/m);
  expect(calls.match(/^pane send-keys w1:p7 Enter$/gm)?.length).toBe(2);
  const msg = readJson(join(home, "runs/sub-1/inbox/a/1.json"));
  expect([msg.status, msg.via]).toEqual(["pending", null]);
  expect(msg.last_error).toMatch(/^queued:/);

  writeFileSync(log, "");
  oh("run", "messages", "sub-1", "retry");
  const retried = readFileSync(log, "utf8");
  expect(retried).not.toMatch(/send-text/);
  expect(retried).toMatch(/^pane send-keys w1:p7 Enter$/m);
}, 60000);

test("a user message to a node also leaves a note for the coordinator", () => {
  const home = seedHome();
  const oh = orch(home, { ORCH_HERDR: "0" });
  oh("run", "start", "Notice test", "--id", "sub-2");
  oh("node", "add", "sub-2", "a", "node");
  oh("node", "tell", "sub-2", "a", "use postgres", "--from", "user");
  const note = readJson(join(home, "runs/sub-2/inbox/orch/2.json"));
  expect([note.from, note.to, note.text]).toEqual(["user", "orch", "user -> a (pending): use postgres"]);
  const inbox = oh("node", "inbox", "sub-2", "a", "--unread");
  expect(inbox.out).toMatch(/^\[m1 from user\] use postgres$/m);
}, 60000);
