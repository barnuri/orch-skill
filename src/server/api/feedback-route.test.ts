import { afterEach, describe, expect, test } from "bun:test";

import { startTestServer } from "../test-support/test-server";
import type { TestServerHandle } from "../types/test-server-handle";

const servers: TestServerHandle[] = [];

afterEach(() => {
  for (const srv of servers.splice(0)) {
    srv.stop();
  }
});

function start(): TestServerHandle {
  const srv = startTestServer();
  servers.push(srv);
  return srv;
}

const post = (srv: TestServerHandle, path: string, body: unknown): Promise<Response> =>
  srv.api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const patch = (srv: TestServerHandle, path: string, body: unknown): Promise<Response> =>
  srv.api(path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

interface Item { id: string; status: string; text: string; source: string; kind: string; work_run?: string }

describe("/api/feedback", () => {
  test("requires the same token as the rest of the API", async () => {
    const srv = start();
    const res = await srv.api("/api/feedback", {}, false);
    expect(res.status).toBe(401);
    const bad = await srv.api("/api/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, false);
    expect(bad.status).toBe(401);
  });

  test("POST adds an item with status new; GET lists it and filters by status", async () => {
    const srv = start();
    const created = await post(srv, "/api/feedback", { text: "Run list is slow", kind: "bug" });
    expect(created.status).toBe(201);
    const { item } = (await created.json()) as { item: Item };
    expect(item.id).toMatch(/^fb-\d{8}-1$/);
    expect(item).toMatchObject({ status: "new", source: "ui", kind: "bug", text: "Run list is slow" });

    const all = (await (await srv.api("/api/feedback")).json()) as { items: Item[] };
    expect(all.items.map((i) => i.id)).toEqual([item.id]);
    const done = (await (await srv.api("/api/feedback?status=done")).json()) as { items: Item[] };
    expect(done.items).toEqual([]);
    expect((await srv.api("/api/feedback?status=nope")).status).toBe(400);
  });

  test("POST rejects a missing text, a bad kind and a bad source", async () => {
    const srv = start();
    expect((await post(srv, "/api/feedback", { kind: "bug" })).status).toBe(400);
    expect((await post(srv, "/api/feedback", { text: "x", kind: "rant" })).status).toBe(400);
    expect((await post(srv, "/api/feedback", { text: "x", source: "email" })).status).toBe(400);
    expect((await post(srv, "/api/feedback", ["x"])).status).toBe(400);
  });

  test("PATCH changes status and result; unknown id is 404", async () => {
    const srv = start();
    const { item } = (await (await post(srv, "/api/feedback", { text: "Fix tooltip" })).json()) as { item: Item };
    const res = await patch(srv, `/api/feedback/${item.id}`, { status: "done", result: "fixed in abc" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: Item & { result?: string } };
    expect(body.item).toMatchObject({ status: "done", result: "fixed in abc" });
    expect((await patch(srv, "/api/feedback/fb-20000101-9", { status: "done" })).status).toBe(404);
    expect((await patch(srv, `/api/feedback/${item.id}`, { status: "later" })).status).toBe(400);
    expect((await patch(srv, `/api/feedback/${item.id}`, {})).status).toBe(400);
  });

  test("POST /work puts the new items into one run and marks them working", async () => {
    const srv = start();
    const { item: a } = (await (await post(srv, "/api/feedback", { text: "First" })).json()) as { item: Item };
    const { item: b } = (await (await post(srv, "/api/feedback", { text: "Second" })).json()) as { item: Item };

    const res = await post(srv, "/api/feedback/work", {});
    expect(res.status).toBe(200);
    const { run_id, items } = (await res.json()) as { run_id: string; items: string[] };
    expect(run_id).toMatch(/^feedback-batch-/);
    expect(items).toEqual([a.id, b.id]);

    const list = (await (await srv.api("/api/feedback")).json()) as { items: Item[] };
    expect(list.items.map((i) => [i.status, i.work_run])).toEqual([["working", run_id], ["working", run_id]]);

    const state = JSON.parse(await Bun.file(`${srv.home.path}/runs/${run_id}/state.json`).text()) as { title: string; nodes: Array<{ id: string }> };
    expect(state.title).toBe("feedback batch");
    expect(state.nodes.map((n) => n.id)).toEqual([a.id, b.id]);

    const again = (await (await post(srv, "/api/feedback/work", {})).json()) as { run_id: string | null; items: string[] };
    expect(again).toEqual({ run_id: null, items: [] });
  });

  test("POST /work with ids rejects an item that is not new", async () => {
    const srv = start();
    const { item } = (await (await post(srv, "/api/feedback", { text: "Once" })).json()) as { item: Item };
    await patch(srv, `/api/feedback/${item.id}`, { status: "done" });
    const res = await post(srv, "/api/feedback/work", { ids: [item.id] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("only new items");
  });

  test("POST /work rejects a malformed ids list", async () => {
    const srv = start();
    expect((await post(srv, "/api/feedback/work", { ids: "fb-20260101-1" })).status).toBe(400);
    expect((await post(srv, "/api/feedback/work", { ids: ["../x"] })).status).toBe(400);
  });

  test("POST for an open run+node merges the text as a note (200, same id); another node gets a new item", async () => {
    const srv = start();
    const first = await post(srv, "/api/feedback", { text: "one", run_id: "r1", node_id: "n1" });
    expect(first.status).toBe(201);
    const { item: a } = (await first.json()) as { item: Item };
    const second = await post(srv, "/api/feedback", { text: "two", run_id: "r1", node_id: "n1" });
    expect(second.status).toBe(200);
    const { item: b } = (await second.json()) as { item: Item & { notes?: { text: string }[] } };
    expect(b.id).toBe(a.id);
    expect(b.notes?.map((n) => n.text)).toEqual(["two"]);
    const other = await post(srv, "/api/feedback", { text: "two", run_id: "r1", node_id: "n2" });
    expect(other.status).toBe(201);
    const list = (await (await srv.api("/api/feedback")).json()) as { items: Item[] };
    expect(list.items).toHaveLength(2);
  });

  test("POST without run or node merges the same normalized text", async () => {
    const srv = start();
    const { item: a } = (await (await post(srv, "/api/feedback", { text: "Slow  list" })).json()) as { item: Item };
    const again = await post(srv, "/api/feedback", { text: " slow LIST " });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { item: Item }).item.id).toBe(a.id);
  });

  test("POST rejects text over 8000 characters and accepts exactly 8000", async () => {
    const srv = start();
    const long = await post(srv, "/api/feedback", { text: "x".repeat(8001) });
    expect(long.status).toBe(400);
    expect(((await long.json()) as { error: string }).error).toContain("8000");
    expect((await post(srv, "/api/feedback", { text: "x".repeat(8000) })).status).toBe(201);
  });
});
