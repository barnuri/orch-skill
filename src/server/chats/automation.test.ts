// test-tier: slow (real dispatch.ts processes: schedule, loop and watch engines on a temp home)
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

import { orchPaths } from "../files/paths";
import { digestToken } from "../http/auth";
import { TempHome } from "../test-support/temp-home";
import type { ServerContext } from "../types/server-context";
import { ChatAutomation, type Notifier, dispatchRunner } from "./automation";
import { ChatService } from "./service";
import type { AgentEvent, AgentSession, SessionFactory } from "./sessions/types";

const FAKE_LOOP = resolve(import.meta.dir, "testing/fake-loop-dispatch.ts");
const PROFILES = { models: { "m-a": { slug: "alpha", harnesses: ["claude"] } }, profiles: { main: { harness: "claude", model: "m-a" } } };

class FakeSession implements AgentSession {
  readonly persistent = true;
  sessionId: string | null = "fake-session";
  constructor(private readonly plan: Plan) {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async dispose(): Promise<void> {}
  async *send(prompt: string): AsyncIterable<AgentEvent> {
    this.plan.prompts.push(prompt);
    this.plan.sessions += 1;
    while (this.plan.gate !== null) {
      await this.plan.gate;
    }
    if (this.plan.fail) {
      yield { type: "error", message: "model unavailable" };
      return;
    }
    yield { type: "text-delta", text: `answer to: ${prompt.split("\n")[0]}` };
    yield { type: "done", session_id: this.sessionId };
  }
}

interface Plan { prompts: string[]; sessions: number; fail: boolean; gate: Promise<void> | null }

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
const saved = { dispatch: process.env.ORCH_DISPATCH, every: process.env.ORCH_EVERY_MIN_SECS, loop: process.env.FAKE_LOOP_DIR, done: process.env.FAKE_LOOP_DONE_AT, fail: process.env.FAKE_LOOP_FAIL };
beforeAll(() => {
  process.env.ORCH_EVERY_MIN_SECS = "1";
  process.env.ORCH_HERDR = "0";
});
afterAll(() => {
  for (const [k, v] of Object.entries({ ORCH_DISPATCH: saved.dispatch, ORCH_EVERY_MIN_SECS: saved.every, FAKE_LOOP_DIR: saved.loop, FAKE_LOOP_DONE_AT: saved.done, FAKE_LOOP_FAIL: saved.fail })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function setup(opts: { fail?: boolean } = {}) {
  const home = TempHome.create();
  home.write("profiles.json", JSON.stringify(PROFILES));
  const plan: Plan = { prompts: [], sessions: 0, fail: opts.fail === true, gate: null };
  const factory: SessionFactory = () => new FakeSession(plan);
  const ctx: ServerContext = { paths: orchPaths(home.path), bindHost: "127.0.0.1", hostname: hostname(), tokenDigest: digestToken("t"), requireToken: true, requireRemoteToken: true, harnesses: ["claude"], outcomes: [] };
  const service = new ChatService(ctx, { factory });
  cleanups.push(() => service.dispose());
  const pushes: Array<{ category: string; body: string; tag: string }> = [];
  const notify: Notifier = async (category, input) => void pushes.push({ category, body: input.body, tag: input.tag });
  let nowMs = Date.now();
  const clock = { set: (ms: number) => (nowMs = ms), get: () => nowMs };
  const auto = new ChatAutomation(service, { home: home.path, now: () => nowMs, notify, pollMs: 5 });
  const chat = service.createChat({ title: "Daily", harness: "claude", profile: "main", cwd: null });
  const cli = dispatchRunner(home.path);
  const schedule = (id: string) => JSON.parse(readFileSync(join(home.path, "schedules", id, "schedule.json"), "utf8"));
  const messages = () => service.store.listMessages(chat.id, { limit: 100 }).items.slice().reverse();
  return { home, plan, service, auto, chat, cli, pushes, clock, schedule, messages };
}

const create = (s: ReturnType<typeof setup>, over: Record<string, unknown> = {}) =>
  s.auto.createSchedule(s.chat.id, { name: "Morning news", prompt: "Summarise the news", cron: "0 9 * * *", timezone: "UTC", ...over } as never);

describe("model and migration", () => {
  test("chats carry an unread flag that the automation sets and reading clears", () => {
    const s = setup();
    expect(s.service.store.schemaVersion()).toBeGreaterThanOrEqual(9);
    expect(s.service.store.getChat(s.chat.id)?.unread).toBe(0);
    s.service.postBlock(s.chat.id, { content: "x", part: { type: "automation", kind: "monitor", level: "info", title: "t" } });
    expect(s.service.store.getChat(s.chat.id)?.unread).toBe(1);
    s.service.markRead(s.chat.id);
    expect(s.service.store.getChat(s.chat.id)?.unread).toBe(0);
  });

  test("a chat schedule stores its target, zone and counters", async () => {
    const s = setup();
    const { id } = await create(s, { mode: "fresh", timezone: "Asia/Jerusalem" });
    const row = s.schedule(id);
    expect(row.target).toEqual({ kind: "chat", chat_id: s.chat.id, mode: "fresh" });
    expect(row.timezone).toBe("Asia/Jerusalem");
    expect([row.consecutive_failures, row.retry_at, row.pause_reason]).toEqual([0, null, null]);
    expect(row.next_at).toBeGreaterThan(Date.now() / 1000);
    expect(s.auto.schedulesOf(s.chat.id).map((x) => x.id)).toEqual([id]);
  });
});

describe("CLI", () => {
  test("add --chat and list --chat go through dispatch.ts", async () => {
    const s = setup();
    const add = await s.cli(["schedule", "add", "--chat", s.chat.id, "--mode", "fresh", "--name", "n", "--cron", "0 9 * * 1-5", "--prompt", "p"]);
    expect(add.code).toBe(0);
    const id = add.out.trim();
    const list = await s.cli(["schedule", "list", "--chat", s.chat.id]);
    expect(list.out).toContain(id);
    expect((await s.cli(["schedule", "list", "--chat", "chat-other"])).out.trim()).toBe("no schedules");
    expect((await s.cli(["schedule", "add", "--chat", s.chat.id, "--mode", "weird", "--name", "n", "--cron", "0 9 * * *", "--prompt", "p"])).code).toBe(2);
    expect((await s.cli(["schedule", "add", "--chat", s.chat.id, "--name", "n", "--cron", "0 9 * * *"])).code).toBe(2);
    expect((await s.cli(["schedule", "add", "--chat", s.chat.id, "--tz", "Mars/Base", "--name", "n", "--cron", "0 9 * * *", "--prompt", "p"])).code).toBe(2);
  });
});

describe("schedule validation and limits", () => {
  test("a cron that fires more often than every 5 minutes, or never, is refused", async () => {
    const s = setup();
    await expect(create(s, { cron: "* * * * *" })).rejects.toThrow(/at least 5 minutes/);
    await expect(create(s, { cron: "*/5 * * * *" })).resolves.toBeDefined();
    await expect(create(s, { cron: "61 * * * *" })).rejects.toThrow(/bad or never-matching/);
  });

  test("50 active chat schedules is the limit", async () => {
    const s = setup();
    for (let i = 0; i < 50; i++) {
      const id = `sch-20260101-000000-${i.toString(16).padStart(4, "0")}`;
      mkdirSync(join(s.home.path, "schedules", id), { recursive: true });
      writeFileSync(join(s.home.path, "schedules", id, "schedule.json"), JSON.stringify({ id, enabled: true, target: { kind: "chat", chat_id: "chat-x", mode: "message" }, runs: [], created_at: "2026-01-01T00:00:00Z" }));
    }
    await expect(create(s)).rejects.toThrow(/limit 50/);
  });

  test("an archived chat takes no new schedule", async () => {
    const s = setup();
    s.service.store.setChatArchived(s.chat.id, true);
    await expect(create(s)).rejects.toThrow(/archived/);
  });

  test("edit changes the schedule and pause then resume switch it", async () => {
    const s = setup();
    const { id } = await create(s);
    await s.auto.editSchedule(s.chat.id, id, { name: "Evening", cron: "0 18 * * *", mode: "fresh", timezone: "Asia/Jerusalem" });
    expect(s.schedule(id)).toMatchObject({ name: "Evening", cron: "0 18 * * *", timezone: "Asia/Jerusalem", target: { mode: "fresh" } });
    await s.auto.setScheduleEnabled(s.chat.id, id, false);
    expect(s.schedule(id)).toMatchObject({ enabled: false, next_at: null });
    await s.auto.setScheduleEnabled(s.chat.id, id, true);
    expect(s.schedule(id).next_at).toBeGreaterThan(0);
    await s.auto.deleteSchedule(s.chat.id, id);
    expect(existsSync(join(s.home.path, "schedules", id))).toBe(false);
    await expect(s.auto.deleteSchedule(s.chat.id, id)).rejects.toThrow(/unknown schedule/);
  });
});

describe("firing a schedule", () => {
  test("message mode appends a marked user message to the same chat, runs it, records it and pushes", async () => {
    const s = setup();
    const { id } = await create(s);
    s.clock.set(s.schedule(id).next_at * 1000 + 2000);
    await s.auto.evaluate();
    await s.auto.idle();
    const [user, reply] = s.messages();
    expect(user?.content).toBe("Scheduled: Morning news\n\nSummarise the news");
    expect(reply?.status).toBe("done");
    expect(reply?.content).toContain("answer to: Scheduled: Morning news");
    expect(s.plan.prompts).toHaveLength(1);
    const row = s.schedule(id);
    expect(row.runs[0]).toMatchObject({ status: "ok", message_id: reply?.id });
    expect(row.runs[0].duration_ms).toBeGreaterThanOrEqual(0);
    expect(row.next_at).toBeGreaterThan(s.clock.get() / 1000);
    expect(s.service.store.getChat(s.chat.id)?.unread).toBe(1);
    expect(s.pushes.some((p) => p.category === "schedules" && p.body.includes("Scheduled result: Morning news") && p.tag === `chat:${s.chat.id}`)).toBe(true);
  });

  test("two ticks claim the fire once", async () => {
    const s = setup();
    const { id } = await create(s);
    s.clock.set(s.schedule(id).next_at * 1000 + 1000);
    await Promise.all([s.auto.evaluate(), s.auto.evaluate()]);
    await s.auto.idle();
    expect(s.plan.prompts).toHaveLength(1);
  });

  test("message mode waits in the queue while the chat is busy and never cuts the running reply", async () => {
    const s = setup();
    let release!: () => void;
    s.plan.gate = new Promise<void>((r) => (release = () => { s.plan.gate = null; r(); }));
    s.service.sendMessage(s.chat.id, { content: "long job" });
    await Bun.sleep(30);
    const { id } = await create(s);
    s.clock.set(s.schedule(id).next_at * 1000 + 1000);
    await s.auto.evaluate();
    await Bun.sleep(80);
    expect(s.service.queue.queued(s.chat.id).map((q) => q.text)).toEqual(["Scheduled: Morning news\n\nSummarise the news"]);
    expect(s.plan.prompts).toHaveLength(1);
    release();
    await s.auto.idle();
    expect(s.plan.prompts.map((p) => p.split("\n")[0])).toEqual(["long job", "Scheduled: Morning news"]);
    expect(s.schedule(id).runs[0].status).toBe("ok");
  });

  test("fresh mode runs a new session and posts a titled result block with a link; the chat's own history is untouched", async () => {
    const s = setup();
    const { id } = await create(s, { mode: "fresh" });
    s.clock.set(s.schedule(id).next_at * 1000 + 1000);
    await s.auto.evaluate();
    await s.auto.idle();
    const msgs = s.messages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.role).toBe("assistant");
    expect(msgs[0]?.content).toBe("answer to: Summarise the news");
    const parts = JSON.parse(msgs[0]!.parts as string);
    expect(parts[1]).toMatchObject({ type: "automation", kind: "schedule", level: "result", title: "Scheduled result: Morning news", link: "#/schedules" });
    expect(s.service.store.getChat(s.chat.id)?.session_id).toBeNull();
    expect(s.schedule(id).runs[0]).toMatchObject({ status: "ok", message_id: msgs[0]!.id });
    expect(s.pushes.at(-1)?.category).toBe("schedules");
  });

  test("run-now fires once without moving the timetable", async () => {
    const s = setup();
    const { id } = await create(s, { mode: "fresh" });
    const next = s.schedule(id).next_at;
    await s.auto.runNow(s.chat.id, id);
    expect(s.schedule(id).runs[0].status).toBe("ok");
    expect(s.schedule(id).next_at).toBe(next);
    expect(s.auto.scheduleLog(s.chat.id, id)[0]?.status).toBe("ok");
  });
});

describe("missed runs and the grace window", () => {
  test("a run missed inside the grace window fires once on boot", async () => {
    const s = setup();
    const { id } = await create(s, { mode: "fresh" });
    s.clock.set(s.schedule(id).next_at * 1000 + 2 * 3600_000);
    await s.auto.evaluate();
    await s.auto.idle();
    expect(s.plan.sessions).toBe(1);
    expect(s.schedule(id).runs).toHaveLength(1);
    await s.auto.evaluate();
    await s.auto.idle();
    expect(s.plan.sessions).toBe(1);
  });

  test("a run missed outside the grace window is skipped and logged, then the timetable moves on", async () => {
    const s = setup();
    const { id } = await create(s, { mode: "fresh" });
    const due = s.schedule(id).next_at;
    s.clock.set(due * 1000 + 7 * 3600_000);
    await s.auto.evaluate();
    await s.auto.idle();
    expect(s.plan.sessions).toBe(0);
    const row = s.schedule(id);
    expect(row.runs[0]).toMatchObject({ status: "skipped" });
    expect(row.runs[0].note).toMatch(/grace window/);
    expect(row.next_at).toBeGreaterThan(due);
    expect(s.messages()).toHaveLength(0);
  });

  test("the grace window is a setting", async () => {
    const s = setup();
    s.home.write("profiles.json", JSON.stringify({ ...PROFILES, settings: { schedule_grace_hours: 1 } }));
    const { id } = await create(s, { mode: "fresh" });
    s.clock.set(s.schedule(id).next_at * 1000 + 2 * 3600_000);
    await s.auto.evaluate();
    expect(s.schedule(id).runs[0].status).toBe("skipped");
  });
});

describe("failures", () => {
  test("a failed run retries once after 5 minutes, then three in a row pause the schedule with a notice in the chat", async () => {
    const s = setup({ fail: true });
    const { id } = await create(s, { mode: "fresh" });
    const due = s.schedule(id).next_at * 1000;
    s.clock.set(due + 1000);
    await s.auto.evaluate();
    await s.auto.idle();
    let row = s.schedule(id);
    expect([row.runs[0].status, row.consecutive_failures, row.retry_at]).toEqual(["failed", 1, Math.floor((due + 1000) / 1000) + 300]);
    s.clock.set(due + 1000 + 299_000);
    await s.auto.evaluate();
    await s.auto.idle();
    expect(s.plan.sessions).toBe(1);
    s.clock.set(due + 1000 + 301_000);
    await s.auto.evaluate();
    await s.auto.idle();
    row = s.schedule(id);
    expect([s.plan.sessions, row.consecutive_failures, row.retry_at, row.enabled]).toEqual([2, 2, null, true]);
    const nextDue = row.next_at * 1000;
    s.clock.set(nextDue + 1000);
    await s.auto.evaluate();
    await s.auto.idle();
    row = s.schedule(id);
    expect([row.enabled, row.next_at]).toEqual([false, null]);
    expect(row.pause_reason).toMatch(/paused after 3 failed runs/);
    const last = s.messages().at(-1)!;
    expect(last.status).toBe("error");
    expect(JSON.parse(last.parts as string)[1]).toMatchObject({ level: "error", title: "Schedule paused: Morning news" });
    await s.auto.setScheduleEnabled(s.chat.id, id, true);
    expect(s.schedule(id)).toMatchObject({ enabled: true, consecutive_failures: 0, pause_reason: null });
  });

  test("a chat that was archived pauses its schedules with a reason and nothing fires", async () => {
    const s = setup();
    const { id } = await create(s);
    s.service.store.setChatArchived(s.chat.id, true);
    s.clock.set(s.schedule(id).next_at * 1000 + 1000);
    await s.auto.evaluate();
    await s.auto.idle();
    expect(s.schedule(id)).toMatchObject({ enabled: false, pause_reason: "the chat was archived" });
    expect(s.plan.prompts).toHaveLength(0);
  });

  test("a once schedule pauses itself after it ran", async () => {
    const s = setup();
    const { id } = await create(s, { mode: "fresh", once: true });
    s.clock.set(s.schedule(id).next_at * 1000 + 1000);
    await s.auto.evaluate();
    await s.auto.idle();
    expect(s.schedule(id)).toMatchObject({ enabled: false, pause_reason: "ran once" });
  });
});

describe("loops from a chat (the orch loop engine, results posted into the thread)", () => {
  function loopEnv(dir: string, extra: Record<string, string> = {}): void {
    process.env.ORCH_DISPATCH = FAKE_LOOP;
    process.env.FAKE_LOOP_DIR = dir;
    delete process.env.FAKE_LOOP_DONE_AT;
    delete process.env.FAKE_LOOP_FAIL;
    Object.assign(process.env, extra);
  }

  async function until(fn: () => boolean, ms = 25_000): Promise<void> {
    const end = Date.now() + ms;
    while (!fn()) {
      if (Date.now() > end) throw new Error("timed out");
      await Bun.sleep(150);
    }
  }

  test("stops at max iterations and posts each iteration with a quiet counter, then the end", async () => {
    const s = setup();
    loopEnv(s.home.path);
    const { id } = await s.auto.createLoop(s.chat.id, { label: "Poll", prompt: "check", every: 1, max: 2 });
    cleanups.push(() => void s.cli(["loop", "stop", id]));
    await until(() => s.auto.loopsOf(s.chat.id)[0]?.status === "done");
    await s.auto.poll();
    const blocks = s.messages().map((m) => ({ text: m.content, part: JSON.parse(m.parts as string)[1] }));
    expect(blocks.map((b) => b.part.counter)).toEqual(["iteration 1 of 2", "iteration 2 of 2", "2 iterations"]);
    expect(blocks[0]!.text).toContain("reply 1");
    expect(blocks[2]!.text).toBe("Loop ended: reached its maximum of iterations.");
    expect(blocks[0]!.part).toMatchObject({ kind: "loop", title: "Loop: Poll", level: "result" });
    expect(s.service.store.getChat(s.chat.id)?.unread).toBe(1);
    await s.auto.poll();
    expect(s.messages()).toHaveLength(3);
    expect(s.auto.loopLog(s.chat.id, id)[0]?.text).toContain("reply 2");
  }, 40_000);

  test("stops when the reply matches the regex", async () => {
    const s = setup();
    loopEnv(s.home.path, { FAKE_LOOP_DONE_AT: "2" });
    const { id } = await s.auto.createLoop(s.chat.id, { label: "Until", prompt: "check", every: 1, max: 9, until_regex: "DONE" });
    cleanups.push(() => void s.cli(["loop", "stop", id]));
    await until(() => s.auto.loopsOf(s.chat.id)[0]?.status === "done");
    expect(s.auto.loopsOf(s.chat.id)[0]).toMatchObject({ reason: "until", iteration: 2 });
    await s.auto.poll();
    expect(s.messages().at(-1)?.content).toBe("Loop ended: its stop condition was met.");
  }, 40_000);

  test("stops when the until command exits 0", async () => {
    const s = setup();
    loopEnv(s.home.path);
    const { id } = await s.auto.createLoop(s.chat.id, { label: "Cmd", prompt: "check", every: 1, max: 9, until_command: `test $(cat ${s.home.path}/count) -ge 2` });
    cleanups.push(() => void s.cli(["loop", "stop", id]));
    await until(() => s.auto.loopsOf(s.chat.id)[0]?.status === "done");
    expect(s.auto.loopsOf(s.chat.id)[0]?.reason).toBe("until");
  }, 40_000);

  test("the user's Stop ends it and says so", async () => {
    const s = setup();
    loopEnv(s.home.path);
    const { id } = await s.auto.createLoop(s.chat.id, { label: "Long", prompt: "check", every: 30, max: 0 });
    await until(() => (s.auto.loopsOf(s.chat.id)[0]?.iteration ?? 0) >= 1);
    await s.auto.stopLoop(s.chat.id, id);
    expect(s.auto.loopsOf(s.chat.id)[0]).toMatchObject({ status: "stopped" });
    await s.auto.poll();
    expect(s.messages().at(-1)?.content).toBe("Loop ended: you stopped it.");
    await expect(s.auto.stopLoop("chat-other", id)).rejects.toThrow(/unknown loop/);
  }, 40_000);

  test("three failures in a row end it as failed with an error notice", async () => {
    const s = setup();
    loopEnv(s.home.path, { FAKE_LOOP_FAIL: "1" });
    const { id } = await s.auto.createLoop(s.chat.id, { label: "Bad", prompt: "check", every: 1, max: 0 });
    cleanups.push(() => void s.cli(["loop", "stop", id]));
    await until(() => s.auto.loopsOf(s.chat.id)[0]?.status === "failed", 35_000);
    expect(s.auto.loopsOf(s.chat.id)[0]).toMatchObject({ reason: "failures", iteration: 3 });
    await s.auto.poll();
    const last = s.messages().at(-1)!;
    expect(last.status).toBe("error");
    expect(last.content).toContain("failed several times");
    expect(s.pushes.some((p) => p.category === "failures")).toBe(true);
  }, 50_000);
});

describe("monitors from a chat (the orch watch engine)", () => {
  async function until(fn: () => boolean, ms = 60_000): Promise<void> {
    const end = Date.now() + ms;
    while (!fn()) {
      if (Date.now() > end) throw new Error("timed out");
      await Bun.sleep(150);
    }
  }
  const stopAll = (s: ReturnType<typeof setup>) => cleanups.push(async () => { for (const m of s.auto.monitorsOf(s.chat.id)) await s.cli(["watch", "stop", m.id]); });

  test("a file change posts a short message, pushes, and `once` stops the monitor", async () => {
    const s = setup();
    stopAll(s);
    const file = join(s.home.path, "watched.txt");
    writeFileSync(file, "one");
    const { id } = await s.auto.createMonitor(s.chat.id, { name: "Notes", spec: { type: "file", target: file }, every: 1, once: true });
    await Bun.sleep(1800);
    await s.auto.poll();
    expect(s.messages()).toHaveLength(0);
    writeFileSync(file, "two");
    await until(() => (s.auto.monitorsOf(s.chat.id)[0]?.events ?? 0) >= 1);
    await s.auto.poll();
    const msg = s.messages()[0]!;
    expect(msg.content).toContain(`${file} changed`);
    expect(JSON.parse(msg.parts as string)[1]).toMatchObject({ kind: "monitor", level: "result", title: "Monitor: Notes" });
    expect(s.pushes.some((p) => p.category === "schedules" && p.body.includes("Notes"))).toBe(true);
    await until(() => s.auto.monitorsOf(s.chat.id)[0]?.status === "stopped");
    await s.auto.poll();
    expect(s.messages().at(-1)?.content).toMatch(/Monitor stopped after its first trigger/);
    expect(s.auto.monitorLog(s.chat.id, id)[0]?.status).toBeDefined();
  }, 40_000);

  test("a command's exit code change triggers; a follow-up prompt runs in the chat", async () => {
    const s = setup();
    stopAll(s);
    const flag = join(s.home.path, "flag");
    await s.auto.createMonitor(s.chat.id, { name: "Flag", spec: { type: "command", target: `test -f ${flag}`, condition: "exit" }, every: 1, then: { mode: "act", prompt: "Tell me what to do next" } });
    await Bun.sleep(1800);
    writeFileSync(flag, "x");
    await until(() => (s.auto.monitorsOf(s.chat.id)[0]?.events ?? 0) >= 1);
    await s.auto.poll();
    await s.service.settledAll(s.chat.id);
    const texts = s.messages().map((m) => m.content);
    expect(texts[0]).toContain("exit 0");
    expect(texts.some((t) => t.startsWith('Monitor "Flag" triggered.\n\nTell me what to do next'))).toBe(true);
    expect(s.plan.prompts.some((p) => p.includes("Tell me what to do next"))).toBe(true);
  }, 40_000);

  test("a URL status change triggers, against a local test server", async () => {
    const s = setup();
    stopAll(s);
    let status = 200;
    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("hi", { status }) });
    cleanups.push(() => void srv.stop(true));
    await s.auto.createMonitor(s.chat.id, { name: "Site", spec: { type: "url", target: `http://127.0.0.1:${srv.port}/`, condition: "status" }, every: 1 });
    await Bun.sleep(1800);
    status = 503;
    await until(() => (s.auto.monitorsOf(s.chat.id)[0]?.events ?? 0) >= 1);
    await s.auto.poll();
    expect(s.messages()[0]?.content).toContain("HTTP 503");
  }, 40_000);

  test("a regex on a command's output triggers; a streamed command posts its matching lines", async () => {
    const s = setup();
    stopAll(s);
    await s.auto.createMonitor(s.chat.id, { name: "Stream", spec: { type: "stream", target: "printf 'fine\\nERROR disk full\\n'; sleep 30", pattern: "ERROR" } });
    await until(() => (s.auto.monitorsOf(s.chat.id)[0]?.events ?? 0) >= 1);
    await s.auto.poll();
    expect(s.messages()[0]?.content).toContain("ERROR disk full");
  }, 40_000);

  test("20 active monitors per chat is the limit", async () => {
    const s = setup();
    stopAll(s);
    const made: string[] = [];
    for (let i = 0; i < 20; i++) made.push((await s.auto.createMonitor(s.chat.id, { name: `m${i}`, spec: { type: "stream", target: "sleep 120" } })).id);
    await expect(s.auto.createMonitor(s.chat.id, { name: "one too many", spec: { type: "stream", target: "sleep 120" } })).rejects.toThrow(/limit 20/);
    for (const id of made) await s.cli(["watch", "stop", id]);
  }, 60_000);

  test("monitors below the minimum interval are raised to it, and a URL monitor under 60 s is refused by the engine", async () => {
    const s = setup();
    stopAll(s);
    const saveEvery = process.env.ORCH_EVERY_MIN_SECS;
    delete process.env.ORCH_EVERY_MIN_SECS;
    try {
      const { id } = await s.auto.createMonitor(s.chat.id, { name: "Fast", spec: { type: "command", target: "true" }, every: 2 });
      expect(s.auto.monitorsOf(s.chat.id).find((m) => m.id === id)?.interval).toBe(10);
      const url = await s.auto.createMonitor(s.chat.id, { name: "Url", spec: { type: "url", target: "http://127.0.0.1:9/" }, every: 5 });
      expect(s.auto.monitorsOf(s.chat.id).find((m) => m.id === url.id)?.interval).toBe(60);
    } finally {
      if (saveEvery !== undefined) process.env.ORCH_EVERY_MIN_SECS = saveEvery;
    }
  }, 30_000);

  test("pause stops it and resume starts an equal one that replaces it in the list", async () => {
    const s = setup();
    stopAll(s);
    const { id } = await s.auto.createMonitor(s.chat.id, { name: "P", spec: { type: "stream", target: "sleep 60" } });
    await s.auto.stopMonitor(s.chat.id, id);
    expect(s.auto.monitorsOf(s.chat.id)[0]).toMatchObject({ id, status: "stopped" });
    const resumed = await s.auto.resumeMonitor(s.chat.id, id);
    const list = s.auto.monitorsOf(s.chat.id);
    expect(list.map((m) => m.id)).toEqual([resumed.id]);
    expect(list[0]?.status).toBe("running");
  }, 30_000);

  test("run-now checks once and posts what it saw", async () => {
    const s = setup();
    stopAll(s);
    const { id } = await s.auto.createMonitor(s.chat.id, { name: "Now", spec: { type: "command", target: "echo hello-there", condition: "regex", pattern: "hello" }, every: 60 });
    await s.auto.checkNow(s.chat.id, id);
    expect(s.messages().at(-1)?.content).toBe("Checked now: hello-there");
  }, 30_000);

  test("URL safety: only http and https, no metadata or link-local, no credentials", async () => {
    const s = setup();
    for (const target of ["file:///etc/passwd", "http://169.254.169.254/latest/meta-data/", "http://[fe80::1]/", "https://u:p@example.com/"]) {
      await expect(s.auto.createMonitor(s.chat.id, { name: "bad", spec: { type: "url", target } })).rejects.toThrow(/http and https|blocked|user name/);
    }
    s.home.write("profiles.json", JSON.stringify({ ...PROFILES, settings: { monitor_allow_link_local: true } }));
    expect(await s.auto.monitorProblem({ type: "url", target: "http://169.254.169.254/" })).toBeNull();
    expect(await s.auto.monitorProblem({ type: "command", target: "x", condition: "regex", pattern: "(" })).toMatch(/regular expression/);
  });
});

describe("the bridge: debounce, expiry, archived chats", () => {
  function fakeWatch(s: ReturnType<typeof setup>, id: string, events: Array<{ n: number; text: string }>, state: Record<string, unknown> = {}, meta: Record<string, unknown> = {}): void {
    const dir = join(s.home.path, "watches", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "spec.json"), JSON.stringify({ id, name: "W", interval: 5, deadline: 0, started: "2026-11-16T00:00:00Z", target: { kind: "chat", chat_id: s.chat.id }, meta: { spec: { type: "command", target: "x" }, ...meta } }));
    writeFileSync(join(dir, "state.json"), JSON.stringify({ id, status: "running", events: events.length, pid: process.pid, ...state }));
    writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify({ ts: "2026-11-16T00:00:01Z", ...e })).join("\n") + "\n");
  }

  test("events inside the debounce window fold into one message with a count, posted when the window ends", async () => {
    const s = setup();
    s.clock.set(1_800_000_000_000);
    fakeWatch(s, "watch-1", [{ n: 1, text: "a" }, { n: 2, text: "b" }, { n: 3, text: "c" }], {}, { debounce: 60 });
    await s.auto.poll();
    const first = s.messages().map((m) => m.content);
    expect(first).toHaveLength(1);
    expect(first[0]).toContain("(3 events in the debounce window)");
    fakeWatch(s, "watch-1", [{ n: 1, text: "a" }, { n: 2, text: "b" }, { n: 3, text: "c" }, { n: 4, text: "d" }], {}, { debounce: 60 });
    s.clock.set(1_800_000_030_000);
    await s.auto.poll();
    expect(s.messages()).toHaveLength(1);
    s.clock.set(1_800_000_061_000);
    await s.auto.poll();
    expect(s.messages()).toHaveLength(2);
    expect(s.messages()[1]?.content).toContain("d");
  });

  test("an expired monitor says so once", async () => {
    const s = setup();
    fakeWatch(s, "watch-2", [], { status: "done", reason: "max-runtime", pid: null });
    await s.auto.poll();
    await s.auto.poll();
    expect(s.messages().map((m) => m.content)).toEqual(["Monitor expired."]);
  });

  test("an archived chat gets nothing posted", async () => {
    const s = setup();
    fakeWatch(s, "watch-3", [{ n: 1, text: "x" }]);
    s.service.store.setChatArchived(s.chat.id, true);
    await s.auto.poll();
    expect(s.messages()).toHaveLength(0);
  });
});

describe("the agent hears about it once", () => {
  test("the instruction line is appended to the first turn of a session only", async () => {
    const s = setup();
    s.service.sendMessage(s.chat.id, { content: "hello" });
    await s.service.settledAll(s.chat.id);
    s.service.sendMessage(s.chat.id, { content: "again" });
    await s.service.settledAll(s.chat.id);
    expect(s.plan.prompts[0]).toContain("You may suggest /schedule, /loop or /watch");
    expect(s.plan.prompts[1]).not.toContain("You may suggest /schedule");
  });
});
