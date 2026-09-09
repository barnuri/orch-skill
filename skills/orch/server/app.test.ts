import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { startTestServer } from "./test-support/test-server";
import type { TestServerHandle } from "./types/test-server-handle";

const API_PATHS: readonly string[] = ["/api/health", "/api/runs", "/api/profiles", "/api/memory"];
const ASSET_ATTR = /(?:src|href)="([^"]+)"/g;

let srv: TestServerHandle;
let port: string;

beforeAll(() => {
  srv = startTestServer();
  port = new URL(srv.url).port;
});

afterAll(() => {
  srv.stop();
});

// The token is a bearer credential; a 404 body or an asset URL that echoed it would leak it
// into browser history, proxy logs and the referrer chain.
async function assertNoToken(res: Response): Promise<void> {
  expect(await res.text()).not.toContain(srv.token);
}

describe("dashboard shell", () => {
  test("GET / serves the HTML shell", async () => {
    const res = await fetch(srv.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('<script type="module"');
    expect(html).toContain("Content-Security-Policy");
    expect(html).not.toContain(srv.token);
  });

  // Bun emits chunk URLs relative to process.cwd(); from the wrong cwd they 404. Resolving
  // each attribute against the page URL is exactly what the browser does.
  test("every bundled asset the shell references resolves", async () => {
    const html = await (await fetch(srv.url)).text();
    const refs = [...html.matchAll(ASSET_ATTR)]
      .map((m) => m[1] ?? "")
      .filter((href) => href.startsWith("/chunk-"));
    expect(refs.length).toBeGreaterThan(0);

    for (const href of refs) {
      const res = await fetch(new URL(href, srv.url));
      expect(res.status).toBe(200);
      const type = res.headers.get("content-type") ?? "";
      expect(/javascript|text\/css/.test(type)).toBe(true);
      await assertNoToken(res);
    }
  });

  // Bun answers the HTML route for any method, and for /index.html as well as /. Both are
  // Bun-owned and harmless — the same public shell, no token in it — so they are documented
  // here rather than fought.
  test("POST / is answered by Bun's HTML route", async () => {
    expect((await fetch(srv.url, { method: "POST" })).status).toBe(200);
  });

  test("/index.html serves the same shell", async () => {
    const res = await srv.api("/index.html");
    expect(res.status).toBe(200);
    await assertNoToken(res);
  });
});

describe("unlisted paths", () => {
  // `/data/index.js` is deliberately still listed: it was the retired file:// dashboard's
  // entry point, and this asserts it never comes back as a served path.
  const paths: readonly string[] = [
    "/serve.token",
    "/profiles.json",
    "/data/index.js",
    "/api/runs/",
    "/api/nope",
  ];

  for (const path of paths) {
    test(`${path} is 404 and leaks nothing`, async () => {
      const res = await srv.api(path);
      expect(res.status).toBe(404);
      await assertNoToken(res);
    });
  }
});

// The default test server sets requireToken, so the block above keeps exercising the bearer
// path. This one is the shipped default: a request from this machine is authorized outright.
describe("loopback bypass", () => {
  let local: TestServerHandle;

  beforeAll(() => {
    local = startTestServer({ requireToken: false });
  });

  afterAll(() => {
    local.stop();
  });

  for (const path of API_PATHS) {
    test(`${path} needs no token over loopback`, async () => {
      const res = await local.api(path, {}, false);
      expect(res.status).toBe(200);
    });
  }

  test("a wrong token over loopback is still accepted", async () => {
    const res = await local.api("/api/health", { headers: { Authorization: "Bearer nope" } }, false);
    expect(res.status).toBe(200);
  });

  test("the correct token still works", async () => {
    const res = await local.api("/api/health");
    expect(res.status).toBe(200);
  });

  test("the host policy still applies", async () => {
    const res = await local.api("/api/health", { headers: { Host: "evil.test" } }, false);
    expect(res.status).toBe(400);
  });
});

describe("auth", () => {
  for (const path of API_PATHS) {
    test(`${path} without a token is 401`, async () => {
      const res = await srv.api(path, {}, false);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
    });
  }

  test("a wrong token is 401", async () => {
    const res = await srv.api("/api/health", { headers: { Authorization: "Bearer nope" } }, false);
    expect(res.status).toBe(401);
  });

  test("Basic auth is 401", async () => {
    const res = await srv.api("/api/health", { headers: { Authorization: "Basic x" } }, false);
    expect(res.status).toBe(401);
  });

  // The query token only unlocks the dashboard shell, which then sends the header; /api/*
  // never accepts it, so the token stays out of server logs and referrers.
  test("?token= alone does not authenticate an API call", async () => {
    const res = await srv.api(`/api/health?token=${srv.token}`, {}, false);
    expect(res.status).toBe(401);
  });
});

describe("host policy", () => {
  test("a foreign Host header is 400", async () => {
    const res = await srv.api("/api/health", { headers: { Host: "evil.test" } });
    expect(res.status).toBe(400);
  });

  test("localhost with the bound port is allowed", async () => {
    const res = await srv.api("/api/health", { headers: { Host: `localhost:${port}` } });
    expect(res.status).toBe(200);
  });
});

describe("methods", () => {
  test("POST to a GET/PUT route is 405 with both verbs allowed", async () => {
    const res = await srv.api("/api/profiles", { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, PUT");
  });

  test("PUT to a read-only route is 405 with GET allowed", async () => {
    const res = await srv.api("/api/runs", { method: "PUT" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });

  // No CORS headers means a cross-origin page can neither read nor forge a write.
  test("a preflight gets no CORS headers", async () => {
    const res = await srv.api("/api/profiles", {
      method: "OPTIONS",
      headers: { Origin: "http://evil.test" },
    });
    expect(res.status).toBe(405);
    for (const [name] of res.headers) {
      expect(name.toLowerCase().startsWith("access-control-")).toBe(false);
    }
  });
});

describe("common headers", () => {
  for (const path of API_PATHS) {
    test(`${path} is no-store and nosniff`, async () => {
      const res = await srv.api(path);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("set-cookie")).toBeNull();
    });
  }
});

describe("health", () => {
  test("it reports this process and home", async () => {
    const body = await (await srv.api("/api/health")).json();
    expect(body.ok).toBe(true);
    expect(body.pid).toBe(process.pid);
    expect(body.home).toBe(srv.home.path);
    expect(body.version).toBe(Bun.version);
  });
});
