import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chatOnlyHash, chatOnlyUrl } from "./chat-only-link";

const read = (rel: string): string => readFileSync(join(import.meta.dir, rel), "utf8");

describe("chat-only deep links", () => {
  test("/chat/<id> selects the thread, ?project= the project, bare /chat nothing", () => {
    expect(chatOnlyHash("/chat/abc", "")).toBe("#/chats/abc");
    expect(chatOnlyHash("/chat/a%20b", "")).toBe("#/chats/a%20b");
    expect(chatOnlyHash("/chat", "?project=p1")).toBe("#/projects/p1");
    expect(chatOnlyHash("/chat", "")).toBeNull();
    expect(chatOnlyHash("/chat/%E0%A4%A", "")).toBeNull();
  });
  test("links carry the token only when asked", () => {
    expect(chatOnlyUrl("http://h", null, null)).toBe("http://h/chat");
    expect(chatOnlyUrl("http://h", "c1", "t k")).toBe("http://h/chat/c1?token=t%20k");
  });
});

describe("chat-only layout", () => {
  const html = read("../chat.html");
  const css = read("chat-only.css");
  const app = read("ChatShell.tsx");
  test("the page has no rail, header or banner, and fills the viewport", () => {
    expect(html).toContain('class="chat-only"');
    expect(app).not.toMatch(/Rail|Header|BuildBanner|TabBar|AppShell/);
    expect(css).toContain("--hdr: 0px; --tabbar-h: 0px");
    expect(css).toContain("env(safe-area-inset-bottom)");
  });
  test("a persistent sidebar from 900px, a drawer below (shared phone rules to 768px, extra rules to 899px)", () => {
    expect(css).toContain("(min-width: 769px) and (max-width: 899px)");
    expect(css).toContain("translateX(-100%)");
  });
  test("the dashboard page reuses ChatsPage, which owns the drawer toggle", () => {
    const page = read("ChatsPage.tsx");
    expect(app).toContain("<ChatsPage");
    expect(app).toContain("ChatFrameContext");
    expect(page).toContain("setDrawer(true)");
    expect(page).toContain("data-drawer");
    expect(page).toContain("Open chat-only");
  });
  test("red only on the error state", () => {
    expect(css).toMatch(/\.chat-only-dot\.is-error \{ background: var\(--er\)/);
  });
});
