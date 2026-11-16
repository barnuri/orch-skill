import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chatUrl, inQuietHours, notificationBody, redactSecrets, safeClickUrl } from "../../shared/push";
import { startTestServer } from "../test-support/test-server";
import { attachChatPush, type ChatSource } from "./chat-hook";
import { PushHub, VISIBLE_SUPPRESS_MS, type Sender } from "./hub";
import { RunWatcher } from "./run-watcher";
import { b64u, vapidPath } from "./webpush";

const tmp = (): string => mkdtempSync(join(tmpdir(), "orch-push-"));
const KEYS = { p256dh: "B".repeat(87), auth: "A".repeat(22) };
const sub = (hub: PushHub, n: number, extra: Partial<Parameters<PushHub["store"]["upsert"]>[0]> = {}) =>
  hub.store.upsert({ endpoint: `https://push.example/${n}`, p256dh: KEYS.p256dh, auth: KEYS.auth, label: `d${n}`, user_agent: "ua", app: "chat", ...extra });

function setup(now = { t: Date.parse("2026-11-16T12:00:00Z") }) {
  const sent: { endpoint: string; payload: any; category: string }[] = [];
  const results = new Map<string, { ok: boolean; status: number; gone?: boolean }>();
  const send: Sender = async (_k, target, payload, o) => {
    sent.push({ endpoint: target.endpoint, payload, category: o.category });
    const r = results.get(target.endpoint) ?? { ok: true, status: 201 };
    return r.ok ? { ok: true, status: r.status } : { ok: false, status: r.status, gone: r.gone === true, error: `status ${r.status}` };
  };
  const hub = new PushHub(tmp(), { now: () => now.t, send });
  return { hub, sent, results, now };
}

describe("notify", () => {
  test("sends to subscribers that want the category, with title, tag, url and a 140-char body", async () => {
    const { hub, sent } = setup();
    sub(hub, 1);
    sub(hub, 2, { categories: ["failures"] });
    const r = await hub.notify("replies", { title: "My chat", body: "x".repeat(400), tag: "chat:c1", url: chatUrl("c1"), chatId: "c1", waiting: true });
    expect(r).toEqual({ sent: 1, suppressed: null, skipped: 1 });
    expect(sent).toHaveLength(1);
    const p = sent[0]!.payload;
    expect(p.title).toBe("My chat");
    expect(p.body.length).toBeLessThanOrEqual(140);
    expect(p.tag).toBe("chat:c1");
    expect(p.data.url).toBe("/chat/#/chats/c1");
    expect(p.badge).toBe(1);
  });

  test("a secret in the text never leaves", async () => {
    const { hub, sent } = setup();
    sub(hub, 1);
    await hub.notify("replies", { body: "key is sk-abcdefghijklmnopqrstuvwx and token=hunter2", tag: "t", url: "/" });
    expect(JSON.stringify(sent[0]!.payload)).not.toMatch(/sk-abcdef|hunter2/);
    expect(redactSecrets("Bearer abcdefghijklmnopqrstuv")).toBe("[hidden]");
  });

  test("suppressed for 3 s after the last visible and focused heartbeat of that chat, not for another chat", async () => {
    const { hub, sent, now } = setup();
    sub(hub, 1);
    hub.presence("c1", true, true);
    expect((await hub.notify("replies", { body: "hi", tag: "a", url: "/", chatId: "c1" })).suppressed).toBe("visible");
    expect((await hub.notify("replies", { body: "hi", tag: "b", url: "/", chatId: "c2" })).sent).toBe(1);
    now.t += VISIBLE_SUPPRESS_MS + 1;
    expect((await hub.notify("replies", { body: "hi", tag: "a", url: "/", chatId: "c1" })).sent).toBe(1);
    hub.presence("c1", true, false);
    expect(hub.isLookingAt("c1")).toBe(false);
    expect(sent).toHaveLength(2);
  });

  test("a heartbeat clears the chat from the badge", async () => {
    const { hub } = setup();
    sub(hub, 1);
    await hub.notify("replies", { body: "a", tag: "1", url: "/", chatId: "c1", waiting: true });
    await hub.notify("questions", { body: "b", tag: "2", url: "/", chatId: "c2", waiting: true });
    expect(hub.badge()).toBe(2);
    hub.presence("c1", true, true);
    expect(hub.badge()).toBe(1);
  });

  test("quiet hours hold back notifications, including a window that wraps midnight", async () => {
    const { hub, sent, now } = setup({ t: Date.parse("2026-11-16T23:30:00Z") });
    sub(hub, 1, { quiet: { enabled: true, start: 22 * 60, end: 7 * 60, tz_offset: 0 } });
    expect((await hub.notify("replies", { body: "x", tag: "t", url: "/" })).sent).toBe(0);
    now.t = Date.parse("2026-11-17T08:00:00Z");
    expect((await hub.notify("replies", { body: "x", tag: "t", url: "/" })).sent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(inQuietHours({ enabled: true, start: 60, end: 120, tz_offset: -60 }, Date.parse("2026-01-01T00:30:00Z"))).toBe(true);
    expect(inQuietHours({ enabled: false, start: 0, end: 1439, tz_offset: 0 }, 0)).toBe(false);
  });

  test("410 removes the device, 5xx keeps it and records the error, success records the time", async () => {
    const { hub, results } = setup();
    const a = sub(hub, 1);
    const b = sub(hub, 2);
    const c = sub(hub, 3);
    results.set(a.endpoint, { ok: false, status: 410, gone: true });
    results.set(b.endpoint, { ok: false, status: 503 });
    await hub.notify("failures", { body: "x", tag: "t", url: "/" });
    const ids = hub.store.list().map((s) => s.id);
    expect(ids).not.toContain(a.id);
    expect(hub.store.get(b.id)?.last_error).toContain("503");
    expect(hub.store.get(c.id)?.last_success_at).not.toBeNull();
  });

  test("a chat event goes to the chat app's devices, a run event to the dashboard's; each falls back to the other", async () => {
    const { hub, sent } = setup();
    sub(hub, 1, { app: "chat" });
    sub(hub, 2, { app: "dashboard" });
    await hub.notify("replies", { body: "x", tag: "a", url: "/", chatId: "c" });
    await hub.notify("runs", { body: "x", tag: "b", url: "/", runId: "r" });
    expect(sent.map((s) => s.endpoint)).toEqual(["https://push.example/1", "https://push.example/2"]);
    hub.store.remove(hub.store.list().find((s) => s.app === "chat")!.id);
    await hub.notify("replies", { body: "x", tag: "c", url: "/", chatId: "c" });
    expect(sent).toHaveLength(3);
  });
});

describe("store", () => {
  test("files are 0600 and the same endpoint upserts in place", () => {
    const home = tmp();
    const hub = new PushHub(home);
    sub(hub, 1);
    sub(hub, 1, { label: "renamed" });
    expect(hub.store.list()).toHaveLength(1);
    expect(hub.store.list()[0]!.label).toBe("renamed");
    expect(statSync(join(home, "push", "subscriptions.json")).mode & 0o777).toBe(0o600);
    expect(new PushHub(home).store.list()).toHaveLength(1);
  });

  test("the vapid private key is created once, 0600", async () => {
    const home = tmp();
    const hub = new PushHub(home);
    const k = await hub.vapid();
    expect(statSync(vapidPath(home)).mode & 0o777).toBe(0o600);
    expect((await new PushHub(home).vapid()).public_key).toBe(k.public_key);
  });
});

describe("chat hook", () => {
  function chatSource() {
    const events = new Set<(id: string, ev: any) => void>();
    const messages = new Map<string, { content: string }>([["m1", { content: "The answer is **42**." }]]);
    const source = { events, store: { getChat: (id: string) => ({ title: `Chat ${id}` }), getMessage: (id: string) => messages.get(id) ?? null } } as unknown as ChatSource;
    const emit = (id: string, ev: unknown): void => events.forEach((l) => l(id, ev));
    return { source, emit };
  }

  test("reply, failure, question and queue pause each notify once with the right category", async () => {
    const { hub, sent } = setup();
    sub(hub, 1);
    const { source, emit } = chatSource();
    attachChatPush(source, hub);
    emit("c1", { event: "done", data: { message_id: "m1", status: "done", error: null } });
    emit("c1", { event: "done", data: { message_id: "m1", status: "stopped", error: null } });
    emit("c1", { event: "done", data: { message_id: "m2", status: "error", error: "boom" } });
    const q = { type: "question", id: "q1", state: "pending", questions: [{ question: "Which one?", options: [{ label: "A" }, { label: "B" }, { label: "C" }] }] };
    emit("c1", { event: "message", data: { message: { parts: [q] } } });
    emit("c1", { event: "message", data: { message: { parts: [q] } } });
    emit("c1", { event: "queue", data: { paused: true, reason: "Paused." } });
    emit("c1", { event: "queue", data: { paused: true, reason: "Paused." } });
    emit("c1", { event: "queue", data: { paused: true, reason: "The reply was stopped." } });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.map((s) => s.category)).toEqual(["replies", "failures", "questions", "failures"]);
    expect(sent[0]!.payload.title).toBe("Chat c1");
    expect(sent[0]!.payload.body).toBe("The answer is 42.");
    expect(sent[2]!.payload.actions.map((a: { title: string }) => a.title)).toEqual(["Open", "A"]);
    expect(sent[2]!.payload.body).toBe("Which one?");
  });
});

describe("run watcher", () => {
  test("announces node and run transitions, watchdog flags and schedule fires, but nothing from before the first scan", () => {
    const home = tmp();
    const run = (status: string, nodeStatus: string) => {
      mkdirSync(join(home, "runs", "20261116-120000-abcd"), { recursive: true });
      writeFileSync(join(home, "runs", "20261116-120000-abcd", "state.json"), JSON.stringify({ run_id: "20261116-120000-abcd", title: "Build it", harness_session: "s", started: "2026-11-16T12:00:00Z", finished: null, status, nodes: [{ id: "n1", label: "Write code", status: nodeStatus }], edges: [] }));
    };
    run("running", "running");
    mkdirSync(join(home, "watchdog"), { recursive: true });
    writeFileSync(join(home, "watchdog", "actions.log"), `${JSON.stringify({ run: "old", node: "x", rule: "stalled", action: "flag", detail: "old" })}\n`);
    const got: { c: string; body: string; url: string }[] = [];
    const w = new RunWatcher(home, (c, i) => void got.push({ c, body: i.body, url: i.url }));
    w.scan();
    expect(got).toEqual([]);
    run("running", "done");
    w.scan();
    run("done", "done");
    w.scan();
    appendFileSync(join(home, "watchdog", "actions.log"), `${JSON.stringify({ run: "20261116-120000-abcd", node: "n1", rule: "unverified", action: "flag", detail: "no handoff" })}\n`);
    mkdirSync(join(home, "schedules", "s1", "claims"), { recursive: true });
    writeFileSync(join(home, "schedules", "s1", "claims", "1790000000"), "{}");
    w.scan();
    w.scan();
    expect(got.map((g) => `${g.c}: ${g.body}`)).toEqual(["runs: Task finished: Write code", "runs: The run finished.", "failures: n1: unverified (no handoff)", "schedules: Schedule s1 fired."]);
    expect(got[0]!.url).toBe("/#/run/20261116-120000-abcd");
  });

  test("a failed node and a failed run use the failures category", () => {
    const home = tmp();
    const write = (status: string, ns: string) => {
      mkdirSync(join(home, "runs", "20261116-120000-abce"), { recursive: true });
      writeFileSync(join(home, "runs", "20261116-120000-abce", "state.json"), JSON.stringify({ run_id: "20261116-120000-abce", title: "", harness_session: "s", started: "2026-11-16T12:00:00Z", finished: null, status, nodes: [{ id: "n", label: "L", status: ns }], edges: [] }));
    };
    write("running", "running");
    const got: string[] = [];
    const w = new RunWatcher(home, (c, i) => void got.push(`${c}|${i.body}`));
    w.scan();
    write("error", "error");
    w.scan();
    expect(got).toEqual(["failures|Task failed: L", "failures|The run failed."]);
  });
});

describe("helpers", () => {
  test("notification body: first 140 chars, no code fences, one line", () => {
    expect(notificationBody("a\n\n```sh\nrm -rf x\n```\nb")).toBe("a b");
    expect(notificationBody("é".repeat(300)).length).toBe(140);
  });

  test("click urls stay on the origin", () => {
    expect(safeClickUrl("/chat/#/chats/1", "https://h:6725")).toBe("/chat/#/chats/1");
    expect(safeClickUrl("https://evil.example/x", "https://h:6725")).toBe("/");
    expect(safeClickUrl("https://h:6725/#/run/r", "https://h:6725")).toBe("/#/run/r");
    expect(safeClickUrl(undefined, "https://h")).toBe("/");
  });
});

describe("push API", () => {
  const srv = startTestServer();
  afterAll(() => srv.stop());
  const post = (path: string, body: unknown, method = "POST") =>
    method === "DELETE" && path === "/api/push/subscribe"
      ? srv.api(`${path}?endpoint=${encodeURIComponent((body as { subscription: { endpoint: string } }).subscription.endpoint)}`, { method })
      : srv.api(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const subscription = (endpoint: string) => ({ endpoint, keys: KEYS });

  test("key is public, 65 raw bytes; the private key is not in any response", async () => {
    const res = await srv.api("/api/push/key");
    const { public_key } = (await res.json()) as { public_key: string };
    expect(Buffer.from(public_key, "base64url").length).toBe(65);
    expect(await srv.api("/api/push/key", {}, false).then((r) => r.status)).toBe(401);
  });

  test("subscribe, list, update, remove by id and by endpoint", async () => {
    const ep = "https://push.example/api1";
    const created = await post("/api/push/subscribe", { subscription: subscription(ep), label: "Pixel", app: "chat" });
    expect(created.status).toBe(201);
    const dev = (await created.json()) as { id: string; service: string };
    expect(dev.service).toBe("push.example");
    const list = (await (await srv.api("/api/push/subscriptions")).json()) as { devices: { id: string; categories: string[] }[] };
    expect(list.devices).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain("push.example/api1");
    const patched = await post(`/api/push/subscriptions/${dev.id}`, { categories: ["failures"] }, "PATCH");
    expect(((await patched.json()) as { categories: string[] }).categories).toEqual(["failures"]);
    expect((await post("/api/push/subscribe", { subscription: subscription(ep), app: "chat" }, "DELETE")).status).toBe(200);
    expect(((await (await srv.api("/api/push/subscriptions")).json()) as { devices: unknown[] }).devices).toHaveLength(0);
    await post("/api/push/subscribe", { subscription: subscription(ep), app: "dashboard" });
    expect((await srv.api(`/api/push/subscriptions/${dev.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await srv.api(`/api/push/subscriptions/${dev.id}`, { method: "DELETE" })).status).toBe(404);
  });

  test("a non-https endpoint and a bad body are refused", async () => {
    expect((await post("/api/push/subscribe", { subscription: subscription("http://evil.example/x"), app: "chat" })).status).toBe(400);
    expect((await post("/api/push/subscribe", { subscription: { endpoint: "https://x.example/", keys: {} }, app: "chat" })).status).toBe(400);
  });

  test("test push reaches a local mock endpoint with a vapid header; a 410 from it removes the device", async () => {
    const seen: { auth: string | null; enc: string | null; bytes: number }[] = [];
    let status = 201;
    const mock = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => {
      seen.push({ auth: req.headers.get("authorization"), enc: req.headers.get("content-encoding"), bytes: (await req.arrayBuffer()).byteLength });
      return new Response(null, { status });
    } });
    try {
      const ep = `http://127.0.0.1:${mock.port}/push/1`;
      const dev = (await (await post("/api/push/subscribe", { subscription: { endpoint: ep, keys: { p256dh: b64u(new Uint8Array([4, ...new Array(64).fill(1)])), auth: KEYS.auth } }, app: "chat" })).json()) as { id: string };
      // the made-up public key is not a valid curve point, so encryption fails before any request: the error is reported, the device stays
      const bad = await (await post("/api/push/test", { id: dev.id })).json();
      expect((bad as { ok: boolean }).ok).toBe(false);
      expect(seen).toHaveLength(0);
      const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
      const p256dh = b64u(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
      const d2 = (await (await post("/api/push/subscribe", { subscription: { endpoint: `${ep}2`, keys: { p256dh, auth: KEYS.auth } }, app: "chat" })).json()) as { id: string };
      const ok = (await (await post("/api/push/test", { id: d2.id })).json()) as { ok: boolean; status: number };
      expect(ok).toMatchObject({ ok: true, status: 201 });
      expect(seen[0]!.auth).toMatch(/^vapid t=/);
      expect(seen[0]!.enc).toBe("aes128gcm");
      expect(seen[0]!.bytes).toBeGreaterThan(100);
      status = 410;
      expect(((await (await post("/api/push/test", { id: d2.id })).json()) as { ok: boolean }).ok).toBe(false);
      const left = ((await (await srv.api("/api/push/subscriptions")).json()) as { devices: { id: string }[] }).devices.map((d) => d.id);
      expect(left).not.toContain(d2.id);
      expect((await post("/api/push/test", { id: "nope" })).status).toBe(404);
    } finally {
      mock.stop(true);
    }
  });

  test("presence answers the badge", async () => {
    const res = await post("/api/push/presence", { chat_id: "c1", visible: true, focused: true });
    expect(await res.json()).toEqual({ badge: 0 });
  });
});
