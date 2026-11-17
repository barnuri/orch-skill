import { afterEach, describe, expect, test } from "bun:test";
import { hostname } from "node:os";
import { resolve } from "node:path";

import { EXITED_MESSAGE } from "../../shared/chat-activity";
import { orchPaths } from "../files/paths";
import { digestToken } from "../http/auth";
import { TempHome } from "../test-support/temp-home";
import type { ServerContext } from "../types/server-context";
import { type ChatEvent, ChatService } from "./service";
import { TurnLiveness } from "./turn-liveness";

describe("TurnLiveness heartbeat (fake clock)", () => {
  const make = () => {
    const clock = { t: 1_000_000 };
    return { clock, live: new TurnLiveness({ now: () => clock.t }) };
  };

  test("state follows the stream: starting, thinking, writing, tool, back to thinking", () => {
    const { clock, live } = make();
    live.begin("c", "m");
    expect(live.snapshot("c")?.state).toBe("starting");
    clock.t += 1000;
    expect(live.note("c", { type: "reasoning-delta", text: "x" })).toBe(true);
    expect(live.snapshot("c")?.state).toBe("thinking");
    expect(live.note("c", { type: "reasoning-delta", text: "y" })).toBe(false);
    live.note("c", { type: "text-delta", text: "hi" });
    expect(live.snapshot("c")?.state).toBe("writing");
    clock.t += 2000;
    live.note("c", { type: "tool", name: "Bash", summary: "ls", id: "t1" });
    clock.t += 7000;
    const tool = live.snapshot("c");
    expect([tool?.state, tool?.tool?.name, tool?.state_ms]).toEqual(["tool", "Bash", 7000]);
    live.note("c", { type: "tool-result", id: "t1", output: "", error: false });
    expect(live.snapshot("c")?.state).toBe("thinking");
    live.end("c");
    expect(live.snapshot("c")).toBeNull();
  });

  test("silent for 45 s is stalled, for 5 min is dead; any event resets; a question pauses the watch", () => {
    const { clock, live } = make();
    live.begin("c", "m");
    clock.t += 44_000;
    expect(live.verdict("c", true).kind).toBe("ok");
    clock.t += 1_000;
    expect(live.verdict("c", true)).toEqual({ kind: "stalled", idle_ms: 45_000 });
    live.note("c", { type: "usage", input_tokens: 1, output_tokens: 1, cost_usd: null, model: null });
    expect(live.verdict("c", true).kind).toBe("ok");
    clock.t += 300_000;
    const dead = live.verdict("c", true);
    expect(dead.kind).toBe("dead");
    expect(dead.kind === "dead" && dead.message).toBe("The agent stopped responding (no output for 5 min). Retry, or change the model in chat settings.");
    live.setWaiting("c", true);
    expect(live.snapshot("c")?.state).toBe("waiting");
    expect(live.verdict("c", true).kind).toBe("ok");
    live.setWaiting("c", false);
    expect(live.snapshot("c")?.state).toBe("thinking");
  });

  test("a gone process is dead after a short grace, not at once", () => {
    const { clock, live } = make();
    live.begin("c", "m");
    clock.t += 1000;
    expect(live.verdict("c", false).kind).toBe("ok");
    clock.t += 5000;
    expect(live.verdict("c", false)).toEqual({ kind: "dead", idle_ms: 6000, message: EXITED_MESSAGE });
    expect(live.verdict("c", null).kind).toBe("ok");
  });
});

const FAKE_SLOW = resolve(import.meta.dir, "testing/fake-claude-slow.ts");
const FAKE_CRASH = resolve(import.meta.dir, "testing/fake-claude-crash.ts");
const PROFILES = { models: { "m-a": { slug: "alpha", harnesses: ["claude"] } }, profiles: { main: { harness: "claude", model: "m-a" } } };
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) {
    await fn();
  }
  for (const k of ["ORCH_CHAT_CLAUDE_BIN", "FAKE_SLOW_TICKS", "FAKE_SLOW_SLEEP", "FAKE_SLOW_GATE"]) {
    delete process.env[k];
  }
});

function boot(bin: string, liveness?: ConstructorParameters<typeof ChatService>[1]): { service: ChatService; home: TempHome } {
  const home = TempHome.create();
  home.write("profiles.json", JSON.stringify(PROFILES));
  process.env.ORCH_CHAT_CLAUDE_BIN = bin;
  const ctx: ServerContext = { paths: orchPaths(home.path), bindHost: "127.0.0.1", hostname: hostname(), tokenDigest: digestToken("t"), requireToken: true, requireRemoteToken: true, harnesses: ["claude"], outcomes: [] };
  const service = new ChatService(ctx, liveness);
  cleanup.push(() => service.dispose());
  return { service, home };
}

async function waitFor(check: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) {
      throw new Error("timed out waiting");
    }
    await Bun.sleep(25);
  }
}

describe("a turn that hangs or crashes never stays streaming", () => {
  test("hang: stall is reported, then the turn is failed with a clear message and the chat is idle", async () => {
    process.env.FAKE_SLOW_TICKS = "2";
    process.env.FAKE_SLOW_SLEEP = "0.05";
    const { service, home } = boot(FAKE_SLOW, { liveness: { stallMs: 400, deadMs: 1200, tickMs: 100 } });
    process.env.FAKE_SLOW_GATE = `${home.path}/never`;
    const chat = service.createChat({ harness: "claude", profile: "main" });
    const events: ChatEvent[] = [];
    service.subscribe(chat.id, null, (e) => events.push(e));
    const sent = service.sendMessage(chat.id, { content: "go" });
    await waitFor(() => events.some((e) => e.event === "activity" && e.data.state === "writing"));
    await waitFor(() => events.some((e) => e.event === "activity" && Number(e.data.idle_ms) >= 400));
    expect(service.store.getMessage(sent.assistant_message_id)?.status).toBe("streaming");
    await waitFor(() => service.store.getMessage(sent.assistant_message_id)?.status === "error");
    const row = service.store.getMessage(sent.assistant_message_id);
    expect(row?.error).toMatch(/^The agent stopped responding \(no output for \d+ s\)\. Retry, or change the model in chat settings\.$/);
    expect(row?.content).toContain("t0");
    await service.settled(chat.id);
    expect(service.chat(chat.id).status).toBe("idle");
    expect(service.store.streamingRows()).toEqual([]);
    expect(service.liveness.snapshot(chat.id)).toBeNull();
    expect(events.filter((e) => e.event === "done")).toHaveLength(1);
  }, 180_000);

  test("crash: a harness that exits non-zero ends as an error naming the exit code", async () => {
    const { service } = boot(FAKE_CRASH);
    const chat = service.createChat({ harness: "claude", profile: "main" });
    const sent = service.sendMessage(chat.id, { content: "go" });
    await service.settled(chat.id);
    const row = service.store.getMessage(sent.assistant_message_id);
    expect(row?.status).toBe("error");
    expect(row?.error ?? "").toMatch(/exited|code 3|unavailable/);
    expect(row?.content).toBe("partial ");
    expect(service.chat(chat.id).status).toBe("idle");
    expect(service.store.streamingRows()).toEqual([]);
  }, 60_000);

  test("reconcile: a streaming row with no turn behind it is closed as interrupted on the next tick", async () => {
    const { service } = boot(FAKE_CRASH, { liveness: { tickMs: 60_000 } });
    const chat = service.createChat({ harness: "claude", profile: "main" });
    const ghost = service.store.addMessage({ chat_id: chat.id, role: "assistant", status: "streaming", content: "half" });
    service.store.updateChat(chat.id, { status: "running" });
    const events: ChatEvent[] = [];
    service.subscribe(chat.id, null, (e) => events.push(e));
    service.watch();
    const row = service.store.getMessage(ghost.id);
    expect([row?.status, row?.content]).toEqual(["error", "half"]);
    expect(row?.error).toStartWith("interrupted:");
    expect(service.chat(chat.id).status).toBe("idle");
    expect(events.map((e) => e.event)).toContain("done");
  });

  test("a dead process leaves no streaming message: the watchdog kills the verdict into an error", async () => {
    process.env.FAKE_SLOW_TICKS = "1";
    process.env.FAKE_SLOW_SLEEP = "0.05";
    const { service, home } = boot(FAKE_SLOW, { liveness: { stallMs: 60_000, deadMs: 60_000, tickMs: 100 } });
    process.env.FAKE_SLOW_GATE = `${home.path}/never`;
    const chat = service.createChat({ harness: "claude", profile: "main" });
    const sent = service.sendMessage(chat.id, { content: "go" });
    await waitFor(() => (service.store.getMessage(sent.assistant_message_id)?.content ?? "").includes("t0"));
    const pid = service.liveness.has(chat.id) ? (service as unknown as { turns: Map<string, { session: { processId: number | null } }> }).turns.get(chat.id)?.session.processId : null;
    expect(typeof pid).toBe("number");
    process.kill(-(pid as number), "SIGKILL");
    await waitFor(() => service.store.getMessage(sent.assistant_message_id)?.status !== "streaming");
    expect(service.store.getMessage(sent.assistant_message_id)?.status).toBe("error");
    expect(service.chat(chat.id).status).toBe("idle");
  }, 60_000);
});
