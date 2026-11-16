import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { ALREADY_STARTED, QUEUE_MAX_ITEMS, QUEUE_MAX_TEXT_BYTES, QueueError } from "./queue";
import { type ChatService, type ChatEvent } from "./service";
import { cleanup, runCleanup, setup, until } from "./testing/queue-harness";
import { blobPath } from "./uploads";

afterEach(runCleanup);

const texts = (service: ChatService, chatId: string): string[] => service.queue.snapshot(chatId).items.map((i) => i.text);

describe("queue: ordering and auto-advance", () => {
  test("a message sent while a reply runs is queued, in order, and runs by itself when the reply ends", async () => {
    const { service, h, chatId } = setup();
    const first = service.submit(chatId, { content: "A" });
    expect(first.queued).toBe(false);
    for (const t of ["B", "C"]) {
      expect(service.submit(chatId, { content: t }).queued).toBe(true);
    }
    expect(service.queue.snapshot(chatId).items.map((i) => [i.text, i.position, i.state])).toEqual([["B", 1, "queued"], ["C", 2, "queued"]]);
    expect(h.prompts).toEqual(["A"]);
    h.current().finish();
    await until(() => h.prompts.length === 2);
    expect(h.prompts).toEqual(["A", "B"]);
    expect(service.queue.snapshot(chatId).items.map((i) => [i.text, i.state, i.position])).toEqual([["B", "running", 0], ["C", "queued", 1]]);
    h.current().finish();
    await until(() => h.prompts.length === 3);
    h.current().finish();
    await service.settledAll(chatId);
    expect(h.prompts).toEqual(["A", "B", "C"]);
    expect(service.queue.snapshot(chatId)).toMatchObject({ items: [], paused: false });
    const userTexts = service.store.listMessages(chatId, { limit: 50 }).items.filter((m) => m.role === "user").map((m) => m.content).reverse();
    expect(userTexts).toEqual(["A", "B", "C"]);
    expect(service.store.getChat(chatId)?.status).toBe("idle");
  });

  test("never two turns at once: only one running turn per chat while several wait", async () => {
    const { service, h, chatId } = setup();
    service.submit(chatId, { content: "A" });
    for (const t of ["B", "C", "D"]) {
      service.submit(chatId, { content: t });
    }
    expect(h.turns).toHaveLength(1);
    h.auto = true;
    h.current().finish();
    await until(() => h.turns.length === 4);
    await service.settledAll(chatId);
    expect(h.prompts).toEqual(["A", "B", "C", "D"]);
  });

  test("a message sent to an idle chat with a paused queue waits behind it", async () => {
    const { service, h, chatId } = setup();
    service.submit(chatId, { content: "A" });
    service.submit(chatId, { content: "B" });
    h.current().fail();
    await service.settledAll(chatId);
    expect(service.queue.snapshot(chatId).paused).toBe(true);
    expect(service.submit(chatId, { content: "C" }).queued).toBe(true);
    expect(texts(service, chatId)).toEqual(["B", "C"]);
    expect(h.prompts).toEqual(["A"]);
  });

  test("queue events are pushed on the chat stream and replayed to a new subscriber", async () => {
    const { service, h, chatId } = setup();
    const events: ChatEvent[] = [];
    service.subscribe(chatId, null, (e) => events.push(e));
    service.submit(chatId, { content: "A" });
    service.submit(chatId, { content: "B" });
    const queueEvents = events.filter((e) => e.event === "queue");
    expect((queueEvents.at(-1)?.data.items as Array<{ text: string }>).map((i) => i.text)).toEqual(["B"]);
    const late = service.subscribe(chatId, null, () => {});
    expect(late.replay.find((e) => e.event === "queue")?.data).toMatchObject({ chat_id: chatId, paused: false });
    h.current().finish();
  });
});

describe("queue: pause after failure or stop", () => {
  test("a failed reply pauses the queue with a reason; resume starts the next message", async () => {
    const { service, h, chatId } = setup();
    service.submit(chatId, { content: "A" });
    service.submit(chatId, { content: "B" });
    h.current().fail();
    await service.settledAll(chatId);
    expect(h.prompts).toEqual(["A"]);
    expect(service.queue.snapshot(chatId)).toMatchObject({ paused: true, reason: "The reply failed." });
    expect(service.store.getChat(chatId)?.status).toBe("idle");
    service.queue.resume(chatId);
    await until(() => h.prompts.length === 2);
    expect(service.queue.snapshot(chatId).paused).toBe(false);
    h.current().finish();
    await service.settledAll(chatId);
  });

  test("stop keeps the partial reply, leaves the queue paused and does not start the next message", async () => {
    const { service, h, chatId } = setup();
    const sent = service.submit(chatId, { content: "A" });
    service.submit(chatId, { content: "B" });
    await until(() => h.turns.length === 1);
    await Bun.sleep(10);
    expect(await service.stop(chatId)).toBe(true);
    expect(h.prompts).toEqual(["A"]);
    const reply = service.store.getMessage((sent as { assistant_message_id: string }).assistant_message_id);
    expect([reply?.status, reply?.content]).toEqual(["stopped", "partial of A"]);
    expect(service.queue.snapshot(chatId)).toMatchObject({ paused: true, reason: "The reply was stopped." });
    expect(texts(service, chatId)).toEqual(["B"]);
  });

  test("stop with an empty queue does not pause anything", async () => {
    const { service, h, chatId } = setup();
    service.submit(chatId, { content: "A" });
    await service.stop(chatId);
    expect(service.queue.snapshot(chatId).paused).toBe(false);
    expect(h.prompts).toEqual(["A"]);
  });

  test("a next message that cannot start (its attachment vanished) keeps its place and pauses the queue", async () => {
    const { service, h, chatId, home } = setup();
    mkdirSync(dirname(blobPath(home.path, "ab".repeat(32))), { recursive: true });
    writeFileSync(blobPath(home.path, "ab".repeat(32)), "x");
    const att = service.store.addAttachment({ chat_id: chatId, filename: "f.txt", mime: "text/plain", size: 1, sha256: "ab".repeat(32), rel_path: "f.txt" });
    service.submit(chatId, { content: "A" });
    service.queue.enqueue(chatId, { content: "B", attachment_ids: [att.id] });
    writeFileSync(blobPath(home.path, "ab".repeat(32)), "x");
    // The blob is trashed after queuing.
    const { rmSync } = await import("node:fs");
    rmSync(blobPath(home.path, "ab".repeat(32)));
    h.current().finish();
    await service.settledAll(chatId);
    const snap = service.queue.snapshot(chatId);
    expect(snap.paused).toBe(true);
    expect(snap.reason).toContain("could not start");
    expect(snap.items.map((i) => [i.text, i.state])).toEqual([["B", "queued"]]);
    expect(h.prompts).toEqual(["A"]);
  });
});

describe("queue: restart recovery", () => {
  test("queued messages survive a restart and show paused; resume runs them", async () => {
    const first = setup();
    first.service.submit(first.chatId, { content: "A" });
    first.service.submit(first.chatId, { content: "B" });
    first.service.submit(first.chatId, { content: "C" });
    await first.service.dispose();
    cleanup.length = 0;
    const second = setup(first.home);
    expect(second.service.queue.snapshot(second.chatId)).toMatchObject({ paused: true, reason: expect.stringContaining("restarted") });
    expect(texts(second.service, second.chatId)).toEqual(["B", "C"]);
    expect(second.h.turns).toHaveLength(0);
    second.service.queue.resume(second.chatId);
    await until(() => second.h.turns.length === 1);
    expect(second.h.prompts).toEqual(["B"]);
    second.h.auto = true;
    second.h.current().finish();
    await until(() => second.h.turns.length === 2);
    await second.service.settledAll(second.chatId);
    expect(second.h.prompts).toEqual(["B", "C"]);
  });

  test("a running queue item at restart is marked sent, not run again", async () => {
    const first = setup();
    first.service.submit(first.chatId, { content: "A" });
    first.service.submit(first.chatId, { content: "B" });
    first.h.current().finish();
    await until(() => first.h.turns.length === 2);
    first.service.submit(first.chatId, { content: "C" });
    await first.service.dispose();
    cleanup.length = 0;
    const second = setup(first.home);
    expect(second.service.queue.snapshot(second.chatId).items.map((i) => [i.text, i.state])).toEqual([["C", "queued"]]);
    expect(second.h.turns).toHaveLength(0);
  });
});

describe("queue: edit and delete races", () => {
  test("edit changes the text while queued; the edited text is what runs", async () => {
    const { service, h, chatId } = setup();
    service.submit(chatId, { content: "A" });
    const queued = service.submit(chatId, { content: "B" });
    const id = (queued as { item: { id: string } }).item.id;
    const edited = service.queue.edit(chatId, id, { content: "B2" });
    expect([edited.text, edited.edited_at === null]).toEqual(["B2", false]);
    h.current().finish();
    await until(() => h.turns.length === 2);
    expect(h.prompts).toEqual(["A", "B2"]);
    h.current().finish();
    await service.settledAll(chatId);
  });

  test("a message that started while it was being edited answers 409 Already started", async () => {
    const { service, h, chatId } = setup();
    service.submit(chatId, { content: "A" });
    const id = (service.submit(chatId, { content: "B" }) as { item: { id: string } }).item.id;
    h.current().finish();
    await until(() => h.turns.length === 2);
    for (const run of [() => service.queue.edit(chatId, id, { content: "late" }), () => service.queue.cancel(chatId, id), () => service.queue.reorder(chatId, [id])]) {
      let err: unknown = null;
      try {
        run();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(QueueError);
      expect([(err as QueueError).status, (err as QueueError).message]).toEqual([409, ALREADY_STARTED]);
    }
    expect(h.prompts).toEqual(["A", "B"]);
    h.current().finish();
    await service.settledAll(chatId);
    expect(() => service.queue.edit(chatId, id, { content: "later" })).toThrow(ALREADY_STARTED);
  });

  test("delete cancels a queued message, closes the gap and unpauses an emptied queue", async () => {
    const { service, h, chatId } = setup();
    service.submit(chatId, { content: "A" });
    const a = (service.submit(chatId, { content: "B" }) as { item: { id: string } }).item.id;
    const b = (service.submit(chatId, { content: "C" }) as { item: { id: string } }).item.id;
    expect(service.queue.cancel(chatId, a).state).toBe("cancelled");
    expect(service.queue.snapshot(chatId).items.map((i) => [i.text, i.position])).toEqual([["C", 1]]);
    expect(() => service.queue.cancel(chatId, a)).toThrow("cancelled");
    h.current().fail();
    await service.settledAll(chatId);
    expect(service.queue.snapshot(chatId).paused).toBe(true);
    service.queue.cancel(chatId, b);
    expect(service.queue.snapshot(chatId)).toMatchObject({ items: [], paused: false });
  });

  test("an unknown queue id is 404", () => {
    const { service, chatId } = setup();
    expect(() => service.queue.edit(chatId, "que-nope", { content: "x" })).toThrow("no such queued message");
  });
});

describe("queue: send now", () => {
  test("stops the running reply (partial kept) and runs the chosen message next, the others after it", async () => {
    const { service, h, chatId } = setup();
    const a = service.submit(chatId, { content: "A" }) as { assistant_message_id: string };
    service.submit(chatId, { content: "B" });
    const c = (service.submit(chatId, { content: "C" }) as { item: { id: string } }).item.id;
    await until(() => h.turns.length === 1);
    const result = await service.queue.sendNow(chatId, c);
    expect(result.interrupted).toBe(true);
    expect(h.prompts).toEqual(["A", "C"]);
    expect(service.store.getMessage(a.assistant_message_id)).toMatchObject({ status: "stopped", content: "partial of A" });
    expect(service.queue.snapshot(chatId)).toMatchObject({ paused: false });
    expect(service.queue.snapshot(chatId).items.map((i) => [i.text, i.state])).toEqual([["C", "running"], ["B", "queued"]]);
    h.current().finish();
    await until(() => h.turns.length === 3);
    expect(h.prompts).toEqual(["A", "C", "B"]);
    h.current().finish();
    await service.settledAll(chatId);
  });

  test("on a paused queue with nothing running it just starts that message", async () => {
    const { service, h, chatId } = setup();
    service.submit(chatId, { content: "A" });
    service.submit(chatId, { content: "B" });
    const c = (service.submit(chatId, { content: "C" }) as { item: { id: string } }).item.id;
    h.current().fail();
    await service.settledAll(chatId);
    const result = await service.queue.sendNow(chatId, c);
    expect(result.interrupted).toBe(false);
    expect(h.prompts).toEqual(["A", "C"]);
    expect(service.queue.snapshot(chatId).paused).toBe(false);
    h.current().finish();
  });

  test("a message that already started cannot be sent now", async () => {
    const { service, h, chatId } = setup();
    service.submit(chatId, { content: "A" });
    const id = (service.submit(chatId, { content: "B" }) as { item: { id: string } }).item.id;
    h.current().finish();
    await until(() => h.turns.length === 2);
    await expect(service.queue.sendNow(chatId, id)).rejects.toThrow(ALREADY_STARTED);
    h.current().finish();
  });
});

describe("queue: reorder", () => {
  test("moves messages; unlisted ones keep their order behind the listed ones", async () => {
    const { service, h, chatId } = setup();
    service.submit(chatId, { content: "A" });
    const ids = ["B", "C", "D"].map((t) => (service.submit(chatId, { content: t }) as { item: { id: string } }).item.id);
    service.queue.reorder(chatId, [ids[2] as string, ids[0] as string]);
    expect(service.queue.snapshot(chatId).items.map((i) => [i.text, i.position])).toEqual([["D", 1], ["B", 2], ["C", 3]]);
    h.auto = true;
    h.current().finish();
    await until(() => h.turns.length === 4);
    await service.settledAll(chatId);
    expect(h.prompts).toEqual(["A", "D", "B", "C"]);
  });

  test("an id that is not queued is refused and nothing moves", () => {
    const { service, chatId } = setup();
    service.submit(chatId, { content: "A" });
    service.submit(chatId, { content: "B" });
    service.submit(chatId, { content: "C" });
    expect(() => service.queue.reorder(chatId, ["que-nope"])).toThrow("no such queued message");
    expect(texts(service, chatId)).toEqual(["B", "C"]);
  });
});

describe("queue: limits", () => {
  test("the 21st queued message is refused with 409", () => {
    const { service, chatId } = setup();
    service.submit(chatId, { content: "A" });
    for (let i = 0; i < QUEUE_MAX_ITEMS; i++) {
      service.submit(chatId, { content: `m${i}` });
    }
    let err: unknown = null;
    try {
      service.submit(chatId, { content: "one too many" });
    } catch (e) {
      err = e;
    }
    expect([(err as QueueError).status, (err as QueueError).message]).toEqual([409, expect.stringContaining("at most 20")]);
    expect(service.queue.snapshot(chatId).items).toHaveLength(QUEUE_MAX_ITEMS);
  });

  test("text over 50 KB is 413, an empty message is 400, edits obey the same limits", () => {
    const { service, chatId } = setup();
    service.submit(chatId, { content: "A" });
    const big = "x".repeat(QUEUE_MAX_TEXT_BYTES + 1);
    expect(() => service.submit(chatId, { content: big })).toThrow("50 KB");
    expect(() => service.submit(chatId, { content: "  " })).toThrow("empty");
    expect(() => service.submit(chatId, { content: "é".repeat(QUEUE_MAX_TEXT_BYTES / 2 + 1) })).toThrow("50 KB");
    const id = (service.submit(chatId, { content: "ok" }) as { item: { id: string } }).item.id;
    expect(() => service.queue.edit(chatId, id, { content: big })).toThrow("50 KB");
    expect(() => service.queue.edit(chatId, id, { content: "" })).toThrow("empty");
    service.submit(chatId, { content: "x".repeat(QUEUE_MAX_TEXT_BYTES) });
  });

  test("an archived chat takes no queued message; unknown attachments are 400", () => {
    const { service, chatId } = setup();
    service.submit(chatId, { content: "A" });
    expect(() => service.submit(chatId, { content: "B", attachment_ids: ["att-nope"] })).toThrow("unknown attachment");
    service.store.setChatArchived(chatId, true);
    expect(() => service.submit(chatId, { content: "B" })).toThrow("archived");
  });
});
