// Vite plugin that answers /api/* from the in-memory mock. No proxy: the dev server never
// forwards a request to a real orch server.
import type { Plugin } from "vite";
import { createMockApi, type MockApi } from "./mock-api";

export const MOCK_API_PREFIX = "/api";

export function orchMockApi(api: MockApi = createMockApi()): Plugin {
  return {
    name: "orch-mock-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "/";
        if (!url.startsWith(MOCK_API_PREFIX)) {
          next();
          return;
        }
        const method = req.method ?? "GET";
        const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);
        const response = api.handle(
          new Request(`http://mock.invalid${url}`, { method, headers: toHeaders(req.headers), body }),
        );
        res.statusCode = response.status;
        response.headers.forEach((value, key) => res.setHeader(key, value));
        res.end(Buffer.from(await response.arrayBuffer()));
      });
    },
  };
}

function toHeaders(raw: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) {
      continue;
    }
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

async function readBody(req: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
