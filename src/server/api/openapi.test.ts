import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { generateOpenApi } from "../../../scripts/gen-openapi";
import { startTestServer } from "../test-support/test-server";

type Op = { summary?: string; tags?: string[]; responses?: Record<string, unknown>; security?: unknown };
type Doc = {
  paths: Record<string, Record<string, Op>>;
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
  security: unknown[];
};

const COMMITTED = resolve(import.meta.dir, "../../../docs/openapi.json");
// Served outside the generated routes on purpose: the artifact viewer is a token-link page, not an API route.
const UNDOCUMENTED: readonly string[] = ["GET /artifact-view/{token}"];

function openApiPath(path: string): string {
  return path.replace(/:([A-Za-z_]+)/g, "{$1}");
}

describe("OpenAPI completeness", () => {
  test("every registered route is documented", async () => {
    const srv = startTestServer();
    try {
      const { buildApi } = await import("./build-api");
      const { orchPaths } = await import("../files/paths");
      const api = buildApi({
        paths: orchPaths(srv.home.path), bindHost: "127.0.0.1", hostname: "localhost", tokenDigest: new Uint8Array(32),
        requireToken: true, requireRemoteToken: true, harnesses: [], outcomes: [],
      });
      const doc = (await (await srv.api("/api/openapi.json")).json()) as Doc;
      const missing: string[] = [];
      for (const route of api.routes) {
        // ALL expands to a documented GET, else the route fails as undocumented.
        const method = route.method === "ALL" ? "GET" : route.method;
        const key = `${method} ${openApiPath(route.path)}`;
        if (UNDOCUMENTED.includes(key)) continue;
        const op = doc.paths[openApiPath(route.path)]?.[method.toLowerCase()];
        if (op === undefined || !op.summary || (op.tags ?? []).length === 0) missing.push(key);
      }
      expect(missing).toEqual([]);
    } finally {
      srv.stop();
    }
  });

  test("declares the auth scheme, shared schemas and the error responses", async () => {
    const doc = JSON.parse(await generateOpenApi()) as Doc;
    expect(Object.keys(doc.components.securitySchemes)).toContain("bearerAuth");
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
    expect(Object.keys(doc.components.schemas).length).toBeGreaterThan(50);
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        expect(Object.keys(op.responses ?? {}), `${method} ${path}`).toEqual(expect.arrayContaining(["401", "500"]));
      }
    }
  });

  test("documents the feedback, skills and requirements routes", async () => {
    const doc = JSON.parse(await generateOpenApi()) as Doc;
    for (const key of [
      "get /api/feedback", "post /api/feedback", "patch /api/feedback/{id}", "post /api/feedback/work",
      "get /api/skills", "get /api/runs/{id}/requirements", "get /api/docs", "get /api/openapi.json",
    ]) {
      const [method, path] = key.split(" ");
      expect(doc.paths[path!]?.[method!], key).toBeDefined();
    }
  });

  test("docs/openapi.json is current (run `bun run openapi`)", async () => {
    expect(readFileSync(COMMITTED, "utf8")).toBe(await generateOpenApi());
  });
});

describe("GET /api/docs", () => {
  test("serves the page behind the same auth", async () => {
    const srv = startTestServer();
    try {
      expect((await srv.api("/api/docs", {}, false)).status).toBe(401);
      const res = await srv.api("/api/docs");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).not.toMatch(/https?:\/\/(?!localhost)/);
    } finally {
      srv.stop();
    }
  });
});
