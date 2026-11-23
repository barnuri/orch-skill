import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { orch, seedHome, runState, readJson, readText, fakeBin, tempDir, waitUntil, autoCleanup } from "../helpers";
autoCleanup();

test("node tell/inbox/ask/answer, rules, broadcast, prompt injection", async () => {
  const home = seedHome();
  const fake = fakeBin({ herdr: `printf '%s\\n' "$*" >> "$ORCH_HERDR_FAKE_LOG"` });
  const log = join(tempDir(), "calls.log"); writeFileSync(log, "");
  const o = orch(home, { ORCH_HERDR: "0" });
  const oh = orch(home, { ORCH_HERDR: "1", PATH: `${fake}:${process.env.PATH}`, ORCH_HERDR_FAKE_LOG: log });
  const msg = (n: string, i: number) => readJson(join(home, "runs/msg-1/inbox", n, `${i}.json`));
  o("run", "start", "Messaging test", "--id", "msg-1");
  for (const [n, g] of [["a", "pane node"], ["b", "inbox node"], ["c", "waiting node"]]) o("node", "add", "msg-1", n, g);
  mkdirSync(join(home, "jobs/job-a"), { recursive: true }); mkdirSync(join(home, "jobs/job-b"), { recursive: true });
  writeFileSync(join(home, "jobs/job-a/herdr_pane"), "w1:p7\n");
  o("node", "update", "msg-1", "a", "running", "--job", "job-a"); o("node", "update", "msg-1", "b", "running", "--job", "job-b");
  let r = oh("node", "tell", "msg-1", "a", "stop editing x.ts");
  expect(r.rc).toBe(0);
  expect(r.out).toMatch(/^m1 a delivered$/m);
  expect(readFileSync(log, "utf8")).toMatch(/^pane send-text w1:p7 \[orch message m1 from orch\] stop editing x.ts$/m);
  expect(readFileSync(log, "utf8")).toMatch(/^pane send-keys w1:p7 Enter$/m);
  expect([msg("a", 1).status, msg("a", 1).via]).toEqual(["delivered", "herdr"]);
  expect(o("node", "tell", "msg-1", "b", "use the new DTO", "--from", "planner").out).toMatch(/^m2 b pending$/m);
  expect(o("node", "inbox", "msg-1", "b").out).toMatch(/^\[m2 from planner\] use the new DTO$/m);
  expect([msg("b", 2).status, msg("b", 2).via]).toEqual(["delivered", "inbox"]);
  expect(o("node", "inbox", "msg-1", "b").all.trim()).toBe("");
  o("node", "tell", "msg-1", "b", "peek me");
  expect(o("node", "inbox", "msg-1", "b", "--json", "--peek").all).toMatch(/peek me/);
  o("node", "inbox", "msg-1", "b", "--ack", "m3", "--via", "plugin");
  expect([msg("b", 3).status, msg("b", 3).via]).toEqual(["delivered", "plugin"]);
  expect(o("node", "tell", "msg-1", "nope", "x").rc).toBe(2);
  expect(o("run", "broadcast", "msg-1", "freeze the API").all).toMatch(/broadcast 2/);
  expect(o("node", "inbox", "msg-1", "c").all.trim()).toBe("");
  expect(o("run", "rule", "add", "msg-1", "never run the full suite").all).toMatch(/rule r1 added/);
  expect(o("run", "rule", "list", "msg-1").out).toMatch(/^r1 never run the full suite$/m);
  expect(o("node", "inbox", "msg-1", "b").all).toMatch(/New run rule: never run the full suite/);
  r = o("node", "ask", "msg-1", "b", "which DTO name?");
  expect(r.out).toMatch(/^m\d+ asked$/m);
  const ask = r.out.trim().split(" ")[0];
  expect(readText(join(home, "runs/msg-1/events.jsonl"))).toMatch(new RegExp(`"kind":"ask".*${ask}: which DTO name`));
  expect(o("node", "answer", "msg-1", "b", "NodeMessage").out).toMatch(new RegExp(`^${ask} answered b pending$`, "m"));
  expect(readJson(join(home, "runs/msg-1/inbox/orch", `${ask.slice(1)}.json`)).answer).toBe("NodeMessage");
  expect(o("node", "inbox", "msg-1", "b").all).toMatch(`Answer to ${ask}: NodeMessage`);
  expect(o("node", "answer", "msg-1", "b", "again").rc).toBe(2);

  const waiter = Bun.spawn(["bun", join(import.meta.dir, "../../scripts/dispatch.ts"), "node", "ask", "msg-1", "b", "go on?", "--wait", "--timeout", "30"],
    { env: { ...process.env, HARNESS_ORCH_HOME: home, ORCH_HERDR: "0", ORCH_ASK_POLL_SECS: "0.1", ORCH_NO_ANNOUNCE: "1" }, stdout: "pipe", stderr: "pipe" });
  const wout = new Response(waiter.stdout).text();
  const orchDir = join(home, "runs/msg-1/inbox/orch");
  await waitUntil(() => { try { return readdirSync(orchDir).some((f) => readFileSync(join(orchDir, f), "utf8").includes('"text":"go on?"')); } catch { return false; } }, 15);
  o("node", "answer", "msg-1", "b", "yes");
  expect(await waiter.exited).toBe(0);
  expect((await wout).trim()).toBe("yes");
  expect(o("node", "inbox", "msg-1", "b").all.trim()).toBe("");
  expect(o.env({ ORCH_ASK_POLL_SECS: "0.1" }, "node", "ask", "msg-1", "b", "late?", "--wait", "--timeout", "1").rc).toBe(4);

  const fake2 = fakeBin({ opencode: `printf 'ARGS %s\\n' "$*"` });
  o("node", "tell", "msg-1", "c", "read this first");
  const job = o.env({ PATH: `${fake2}:${process.env.PATH}` }, "node", "dispatch", "msg-1", "c", "opencode", "do c").out.trim();
  o("wait", job, "--timeout", "60", "--interval", "0.1");
  const jl = readText(join(home, "jobs", job, "log"));
  expect(jl).toMatch(/never run the full suite/);
  expect(jl).toMatch(/read this first/);
  expect(runState(home, "msg-1").nodes.find((n: any) => n.id === "c").prompt).toBe("do c");
  expect(o("node", "inbox", "msg-1", "c").all.trim()).toBe("");
  expect(o("run", "messages", "msg-1").all).toMatch(/\[ask\]/);
  expect(o("run", "messages", "msg-1", "--json").out).toMatch(/^\[/);
}, 240000);

import { coordinatorSessionId } from "../../core/commands/inbox.ts";

test("coordinator session id falls back to the shell's opencode session when the pane has none", () => {
  expect(coordinatorSessionId("", { OPENCODE_SESSION_ID: "ses_x" } as NodeJS.ProcessEnv)).toBe("ses_x");
  expect(coordinatorSessionId("ses_pane", { OPENCODE_SESSION_ID: "ses_x" } as NodeJS.ProcessEnv)).toBe("ses_pane");
  expect(coordinatorSessionId("", { ORCH_COORD_SESSION: "ses_env", OPENCODE_SESSION_ID: "ses_x" } as NodeJS.ProcessEnv)).toBe("ses_env");
  expect(coordinatorSessionId("", {} as NodeJS.ProcessEnv)).toBe("");
});
