import { afterEach, describe, expect, test } from "bun:test";

import type { ChatEvent } from "./service";
import { runCleanup, setup, until } from "./testing/queue-harness";

afterEach(runCleanup);

function questionIdOf(service: ReturnType<typeof setup>["service"], chatId: string): string {
  const row = service.store.pendingQuestionRows(chatId)[0];
  return (JSON.parse(row?.parts ?? "[]") as Array<{ id: string }>)[0]?.id as string;
}

describe("queue and a pending question", () => {
  test("a question pauses the queue: the next message does not start, the chat is waiting", async () => {
    const { service, h, chatId } = setup();
    h.askNext = true;
    service.submit(chatId, { content: "A" });
    service.submit(chatId, { content: "B" });
    h.current().finish();
    await service.settledAll(chatId);
    await Bun.sleep(30);
    expect(h.prompts).toEqual(["A"]);
    const chat = service.chat(chatId);
    expect(chat.status).toBe("idle");
    expect(service.statusOf(chat)).toBe("waiting");
    const snap = service.queue.snapshot(chatId);
    expect(snap).toMatchObject({ paused: false, waiting_for_answer: true });
    expect(snap.items.map((i) => [i.text, i.state])).toEqual([["B", "queued"]]);
  });

  test("the answer runs first, then the queue goes on in order", async () => {
    const { service, h, chatId } = setup();
    h.askNext = true;
    service.submit(chatId, { content: "A" });
    service.submit(chatId, { content: "B" });
    service.submit(chatId, { content: "C" });
    h.current().finish();
    await service.settledAll(chatId);
    service.answerQuestion(chatId, questionIdOf(service, chatId), [["Red"]]);
    expect(h.prompts[1]).toContain("[Answer to your question]");
    expect(service.queue.snapshot(chatId).waiting_for_answer).toBe(false);
    h.auto = true;
    h.current().finish();
    await until(() => h.turns.length === 4);
    await service.settledAll(chatId);
    expect(h.prompts).toEqual(["A", "[Answer to your question]", "B", "C"]);
    expect(service.statusOf(service.chat(chatId))).toBe("idle");
  });

  test("skipping the question also lets the queue go on", async () => {
    const { service, h, chatId } = setup();
    h.askNext = true;
    service.submit(chatId, { content: "A" });
    service.submit(chatId, { content: "B" });
    h.current().finish();
    await service.settledAll(chatId);
    service.answerQuestion(chatId, questionIdOf(service, chatId), null);
    h.auto = true;
    h.current().finish();
    await until(() => h.turns.length === 3);
    await service.settledAll(chatId);
    expect(h.prompts[2]).toBe("B");
  });

  test("a message sent while the question waits queues behind the waiting ones and does not dismiss the question", async () => {
    const { service, h, chatId } = setup();
    h.askNext = true;
    service.submit(chatId, { content: "A" });
    service.submit(chatId, { content: "B" });
    h.current().finish();
    await service.settledAll(chatId);
    expect(service.submit(chatId, { content: "C" }).queued).toBe(true);
    expect(service.queue.snapshot(chatId).items.map((i) => i.text)).toEqual(["B", "C"]);
    expect(service.store.pendingQuestionRows(chatId)).toHaveLength(1);
    expect(h.prompts).toEqual(["A"]);
  });

  test("send now is the person's choice: it starts the message and ends the wait", async () => {
    const { service, h, chatId } = setup();
    h.askNext = true;
    service.submit(chatId, { content: "A" });
    const item = service.queue.enqueue(chatId, { content: "B" });
    h.current().finish();
    await service.settledAll(chatId);
    expect(h.prompts).toEqual(["A"]);
    await service.queue.sendNow(chatId, item.id);
    expect(h.prompts).toEqual(["A", "B"]);
    expect(service.store.pendingQuestionRows(chatId)).toHaveLength(0);
    h.current().finish();
    await service.settledAll(chatId);
  });

  test("send now while a question waits: sends only the chosen message, the rest stay queued and the queue pauses", async () => {
    const { service, h, chatId } = setup();
    h.askNext = true;
    service.submit(chatId, { content: "A" });
    service.submit(chatId, { content: "B" });
    service.submit(chatId, { content: "C" });
    h.current().finish();
    await service.settledAll(chatId);
    expect(service.queue.snapshot(chatId).waiting_for_answer).toBe(true);
    const b = service.queue.snapshot(chatId).items[0]?.id as string;
    h.askNext = false;
    await service.queue.sendNow(chatId, b);
    expect(h.prompts).toEqual(["A", "B"]);
    h.current().finish();
    await service.settledAll(chatId);
    expect(service.queue.snapshot(chatId)).toMatchObject({ paused: true, reason: "Sent one message now. 1 more is waiting: Resume to send them." });
    expect(service.queue.snapshot(chatId).items.map((i) => [i.text, i.state])).toEqual([["C", "queued"]]);
    expect(h.prompts).toEqual(["A", "B"]);
  });

  test("Resume does not start a message while the question waits", async () => {
    const { service, h, chatId } = setup();
    h.askNext = true;
    service.submit(chatId, { content: "A" });
    service.submit(chatId, { content: "B" });
    h.current().finish();
    await service.settledAll(chatId);
    service.queue.resume(chatId);
    expect(h.prompts).toEqual(["A"]);
    expect(service.queue.snapshot(chatId).waiting_for_answer).toBe(true);
  });

  test("the chat stream says waiting when the reply ends with a question, running when the answer starts, idle at the end", async () => {
    const { service, h, chatId } = setup();
    const statuses: string[] = [];
    service.subscribe(chatId, null, (e: ChatEvent) => {
      if (e.event === "status") {
        statuses.push(e.data.status as string);
      }
    });
    h.askNext = true;
    service.submit(chatId, { content: "A" });
    h.current().finish();
    await service.settledAll(chatId);
    expect(statuses).toEqual(["running", "waiting"]);
    const late = service.subscribe(chatId, null, () => {});
    expect(late.replay.find((e) => e.event === "status")?.data).toMatchObject({ status: "waiting" });
    service.answerQuestion(chatId, questionIdOf(service, chatId), [["Blue"]]);
    h.current().finish();
    await service.settledAll(chatId);
    expect(statuses).toEqual(["running", "waiting", "running", "idle"]);
  });

  test("an idle chat with no question and a queue that is empty is idle; with no queue a question alone shows waiting", async () => {
    const { service, h, chatId } = setup();
    h.askNext = true;
    service.submit(chatId, { content: "A" });
    h.current().finish();
    await service.settledAll(chatId);
    expect(service.statusOf(service.chat(chatId))).toBe("waiting");
    expect(service.queue.snapshot(chatId).waiting_for_answer).toBe(false);
  });
});
