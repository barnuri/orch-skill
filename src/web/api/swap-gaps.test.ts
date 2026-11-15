import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRoute, routeKey } from "../router/route";

const g = globalThis as Record<string, unknown>;
const mem = new Map<string, string>();
const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v), removeItem: (k: string) => mem.delete(k) };

const GLOBALS = ["sessionStorage", "location", "history", "document", "localStorage", "matchMedia"];
let saved: Map<string, PropertyDescriptor | undefined>;
const restore = () => {
  for (const [k, d] of saved) { if (d) Object.defineProperty(g, k, d); else delete g[k]; }
};

beforeEach(() => {
  saved = new Map(GLOBALS.map((k) => [k, Object.getOwnPropertyDescriptor(g, k)]));
  mem.clear();
  g["sessionStorage"] = storage;
  g["location"] = { search: "?token=abc", pathname: "/", hash: "#/chats/p1/c1" };
  g["history"] = { replaceState: (_s: unknown, _t: string, url: string) => { (g["location"] as { hash: string }).hash = url.slice(url.indexOf("#")); } };
});
afterEach(restore);

describe("token", () => {
  test("?token= is kept in sessionStorage", async () => {
    const { adoptTokenFromUrl, getToken } = await import("./token");
    adoptTokenFromUrl();
    expect(getToken()).toBe("abc");
    expect(mem.get("orch-token")).toBe("abc");
  });
});

describe("deep link", () => {
  test("#/chats/<project>/<chat>", () => {
    const r = parseRoute("#/chats/p%201/c1");
    expect(r).toEqual({ kind: "chats", chatId: "c1", projectId: "p 1" });
    expect(routeKey(r)).toBe("chats:c1");
    expect(parseRoute("#/chats/c1")).toEqual({ kind: "chats", chatId: "c1" });
  });
});

describe("theme boot", () => {
  test("index loads theme-boot.js before the stylesheet and it sets data-theme", () => {
    const html = readFileSync(join(import.meta.dir, "..", "index.html"), "utf8");
    expect(html.indexOf("theme-boot.js")).toBeGreaterThan(-1);
    expect(html.indexOf("theme-boot.js")).toBeLessThan(html.indexOf("styles.css"));
    const code = readFileSync(join(import.meta.dir, "..", "theme-boot.js"), "utf8");
    const attrs: string[] = [];
    g["document"] = { documentElement: { setAttribute: (_k: string, v: string) => attrs.push(v) } };
    g["localStorage"] = { getItem: () => "light" };
    g["matchMedia"] = () => ({ matches: false });
    new Function(code)();
    expect(attrs).toEqual(["light"]);
  });
});
