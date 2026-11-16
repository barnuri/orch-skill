import { afterAll, describe, expect, test } from "bun:test";

import { startTestServer } from "./test-support/test-server";

const srv = startTestServer();
afterAll(() => {
  srv.stop();
});

const get = (path: string): Promise<Response> => fetch(new URL(path, srv.url));

describe("chat-only page", () => {
  for (const path of ["/chat", "/chat/", "/chat/abc123", "/chat?project=p1", "/chat?folder=%2Ftmp"]) {
    test(`GET ${path} is the chromeless html with the app meta`, async () => {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain("apple-touch-icon");
      expect(html).toContain("apple-mobile-web-app-capable");
      expect(html).toContain("chat-only");
      expect(html).not.toContain("Server out of date");
    });
  }

  test("the page itself needs no token (the token only guards /api)", async () => {
    expect((await get("/chat?token=wrong")).status).toBe(200);
    expect((await get("/api/chats")).status).toBe(401);
  });

  test("the manifest is standalone with start_url /chat/ and icons that resolve", async () => {
    const res = await get("/chat/manifest.webmanifest");
    expect(res.status).toBe(200);
    const m = (await res.json()) as { name: string; display: string; start_url: string; icons: { src: string }[] };
    expect(m).toMatchObject({ name: "Orch chat", display: "standalone", start_url: "/chat/" });
    for (const icon of m.icons) {
      const r = await get(icon.src);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("image/png");
    }
  });

  test("an unknown path below /chat is 404", async () => {
    expect((await get("/chat/a/b")).status).toBe(404);
    expect((await get("/chat/icon.png/x")).status).toBe(404);
  });
});
