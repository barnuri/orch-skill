import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { ChatService } from "./service";
import { runCleanup, setup } from "./testing/queue-harness";
import { blobPath, deleteUnattached, SWEEP_AGE_MS, sweepUnattached } from "./uploads";

afterEach(runCleanup);

const DAY_AFTER = (): number => Date.now() + SWEEP_AGE_MS + 60_000;

function upload(service: ChatService, home: string, chatId: string, name: string, sha: string): string {
  const path = blobPath(home, sha);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, name);
  return service.store.addAttachment({ chat_id: chatId, filename: name, mime: "text/plain", size: name.length, sha256: sha, rel_path: name }).id;
}

describe("queue attachments: held by the queue row", () => {
  test("the startup sweep keeps an old upload of a queued message and still removes a plain old upload", () => {
    const { service, home, h, chatId } = setup();
    service.submit(chatId, { content: "A" });
    const held = upload(service, home.path, chatId, "held.txt", "a1".repeat(32));
    const loose = upload(service, home.path, chatId, "loose.txt", "b2".repeat(32));
    const item = service.queue.enqueue(chatId, { content: "B", attachment_ids: [held] });
    expect(service.store.getAttachment(held)?.queue_id).toBe(item.id);
    expect(service.store.getAttachment(loose)?.queue_id).toBeNull();

    expect(sweepUnattached(service.store, home.path, DAY_AFTER())).toBe(1);
    expect(service.store.getAttachment(held)).not.toBeNull();
    expect(existsSync(blobPath(home.path, "a1".repeat(32)))).toBe(true);
    expect(service.store.getAttachment(loose)).toBeNull();
    expect(existsSync(blobPath(home.path, "b2".repeat(32)))).toBe(false);
    h.current().finish();
  });

  test("a restart sweep keeps the upload; the message still starts with its file", async () => {
    const first = setup();
    first.service.submit(first.chatId, { content: "A" });
    const id = upload(first.service, first.home.path, first.chatId, "keep.txt", "c3".repeat(32));
    first.service.queue.enqueue(first.chatId, { content: "B", attachment_ids: [id] });
    await first.service.dispose();
    const second = setup(first.home);
    // What the constructor does on every start, seen from 25 hours later.
    expect(sweepUnattached(second.service.store, first.home.path, DAY_AFTER())).toBe(0);
    second.service.queue.resume(second.chatId);
    expect(second.h.prompts).toEqual(["B"]);
    expect(second.service.store.getAttachment(id)?.message_id).not.toBeNull();
    expect(second.service.store.getAttachment(id)?.queue_id).toBeNull();
    second.h.current().finish();
    await second.service.settledAll(second.chatId);
  });

  test("a sent message keeps its files as the message's attachments; the sweep never touches them", async () => {
    const { service, home, h, chatId } = setup();
    service.submit(chatId, { content: "A" });
    const id = upload(service, home.path, chatId, "sent.txt", "d4".repeat(32));
    service.queue.enqueue(chatId, { content: "B", attachment_ids: [id] });
    h.current().finish();
    while (h.turns.length < 2) {
      await Bun.sleep(5);
    }
    const row = service.store.getAttachment(id);
    expect(row?.message_id).not.toBeNull();
    expect(row?.queue_id).toBeNull();
    expect(sweepUnattached(service.store, home.path, DAY_AFTER())).toBe(0);
    expect(existsSync(blobPath(home.path, "d4".repeat(32)))).toBe(true);
    h.current().finish();
    await service.settledAll(chatId);
  });

  test("cancelling the queued message deletes its upload and the file", () => {
    const { service, home, h, chatId } = setup();
    service.submit(chatId, { content: "A" });
    const id = upload(service, home.path, chatId, "gone.txt", "e5".repeat(32));
    const item = service.queue.enqueue(chatId, { content: "B", attachment_ids: [id] });
    service.queue.cancel(chatId, item.id);
    expect(service.store.getAttachment(id)).toBeNull();
    expect(existsSync(blobPath(home.path, "e5".repeat(32)))).toBe(false);
    h.current().finish();
  });

  test("cancelling keeps a file another upload still uses (same content)", () => {
    const { service, home, h, chatId } = setup();
    service.submit(chatId, { content: "A" });
    const sha = "f6".repeat(32);
    const shared = upload(service, home.path, chatId, "shared.txt", sha);
    const other = upload(service, home.path, chatId, "shared.txt", sha);
    const item = service.queue.enqueue(chatId, { content: "B", attachment_ids: [shared] });
    service.queue.cancel(chatId, item.id);
    expect(service.store.getAttachment(shared)).toBeNull();
    expect(service.store.getAttachment(other)).not.toBeNull();
    expect(existsSync(blobPath(home.path, sha))).toBe(true);
    h.current().finish();
  });

  test("an edit that drops an upload releases it: it is a plain pending upload again and the sweep may remove it", () => {
    const { service, home, h, chatId } = setup();
    service.submit(chatId, { content: "A" });
    const keep = upload(service, home.path, chatId, "keep.txt", "17".repeat(32));
    const drop = upload(service, home.path, chatId, "drop.txt", "28".repeat(32));
    const item = service.queue.enqueue(chatId, { content: "B", attachment_ids: [keep, drop] });
    service.queue.edit(chatId, item.id, { attachment_ids: [keep] });
    expect(service.store.getAttachment(keep)?.queue_id).toBe(item.id);
    expect(service.store.getAttachment(drop)?.queue_id).toBeNull();
    expect(sweepUnattached(service.store, home.path, DAY_AFTER())).toBe(1);
    expect(service.store.getAttachment(drop)).toBeNull();
    expect(service.store.getAttachment(keep)).not.toBeNull();
    h.current().finish();
  });

  test("a held upload cannot be deleted through the unattached-upload call; a queue row that is over releases its hold", () => {
    const { service, home, h, chatId } = setup();
    service.submit(chatId, { content: "A" });
    const id = upload(service, home.path, chatId, "held.txt", "39".repeat(32));
    const item = service.queue.enqueue(chatId, { content: "B", attachment_ids: [id] });
    expect(deleteUnattached(service.store, home.path, id)).toBe(false);
    expect(service.store.getAttachment(id)).not.toBeNull();
    // A hold whose queue row is no longer queued or running (a stale marker) does not protect the upload.
    service.store.handle.query("UPDATE chat_queue SET state = 'sent' WHERE id = ?").run(item.id);
    expect(sweepUnattached(service.store, home.path, DAY_AFTER())).toBe(1);
    expect(service.store.getAttachment(id)).toBeNull();
    h.current().finish();
  });
});
