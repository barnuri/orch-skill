// Vite plugin that answers /api/* from the in-memory mock. No proxy: the dev server never
// forwards a request to a real orch server.
import { transform } from "esbuild";
import type { Plugin } from "vite";
import { createMockApi, type MockApi } from "./mock-api";

export const MOCK_API_PREFIX = "/api/";

// src/web/api/*.ts are source modules, served by Vite. Only non-module paths under /api/ are API calls.
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|css|map|json)(?:\?|$)/;

export function isMockApiPath(url: string): boolean {
  return url.startsWith(MOCK_API_PREFIX) && !SOURCE_FILE.test(url.split("?")[0] ?? "");
}

export function orchMockApi(api: MockApi = createMockApi()): Plugin {
  return {
    name: "orch-mock-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "/";
        if (!isMockApiPath(url)) {
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

const SHIM_SCRIPT = `<script type="module" src="/@fs/__SHIM__"></script>`;

/**
 * Dev-only page changes for the Vite lane, both reverted by production builds:
 * - a Symbol.metadata shim loaded before the app (see shims.ts);
 * - `style-src 'self' 'unsafe-inline'`, because Vite's dev server injects <style> tags for CSS imports
 *   and the app's CSP blocks them. The production CSP in src/web/index.html is unchanged on disk.
 */
export function orchMockDevPage(shimPath: string): Plugin {
  return {
    name: "orch-mock-dev-page",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return html
          .replace("style-src 'self';", "style-src 'self' 'unsafe-inline';")
          .replace('<script type="module" src="./main.tsx">', `${SHIM_SCRIPT.replace("__SHIM__", shimPath)}\n<script type="module" src="./main.tsx">`);
      },
    },
  };
}

const SHARED_SOURCE = /\/src\/shared\/[^?]+\.ts$/;
const DECORATOR_LINE = /^\s*(?:export\s+)?@\w/m;

/**
 * Lowers Stage-3 class decorators in src/shared/dto with esbuild. Vite's oxc transform leaves them in place,
 * and the browser cannot parse them. esbuild inlines its helpers, so the output needs no extra runtime module.
 */
export function orchLowerDecorators(): Plugin {
  return {
    name: "orch-lower-stage3-decorators",
    enforce: "pre",
    async transform(code, id) {
      const file = id.split("?")[0] ?? id;
      if (!SHARED_SOURCE.test(file) || !DECORATOR_LINE.test(code)) {
        return null;
      }
      const out = await transform(code, { loader: "ts", target: "es2022", sourcefile: file, format: "esm" });
      return { code: out.code, map: null };
    },
  };
}
