import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installDom } from "../test/dom";

// happy-dom does no layout, so these pin the CSS rules that fixed the emulated-iPhone defects.
const uninstall = installDom();
const { DRAWER_QUERY } = await import("./ChatsPage");
afterAll(() => {
  uninstall();
});

const chatsCss = readFileSync(join(import.meta.dir, "chats.css"), "utf8");
const shellCss = readFileSync(join(import.meta.dir, "..", "shell", "shell.css"), "utf8");

/** The body of the first rule whose selector line starts with `selector` (top level). */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  expect(at).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
}

/** The body of the `@media <query>` block. */
function media(css: string, query: string): string {
  const at = css.indexOf(`@media ${query} {`);
  expect(at).toBeGreaterThan(-1);
  const next = css.indexOf("\n}", at);
  return css.slice(at, next);
}

describe("mobile chat layout", () => {
  test("picker buttons shrink to their grid cell instead of overlapping the next picker", () => {
    expect(rule(chatsCss, ".picker")).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(rule(chatsCss, ".picker-btn")).toContain("min-width: 0");
    expect(rule(chatsCss, ".picker-btn .select-value")).toContain("min-width: 0");
  });

  test("a landscape phone gets the drawer layout, and the JS shortcut uses the same query", () => {
    const phone = media(chatsCss, DRAWER_QUERY);
    expect(phone).toContain(".chats-side {");
    expect(DRAWER_QUERY).toContain("(max-height: 500px) and (pointer: coarse)");
    expect(media(shellCss, "(min-width: 720px) and (max-height: 500px) and (pointer: coarse)")).toContain("var(--rail-w-collapsed)");
  });

  test("the chat height and the drawer subtract the tab bar only when it is shown", () => {
    const phone = media(chatsCss, DRAWER_QUERY);
    expect(phone).toContain("- var(--tabbar-h, 0px) - var(--kb, 0px)");
    expect(phone).toContain("bottom: var(--tabbar-h, 0px)");
    expect(media(shellCss, "(max-width: 719px)")).toContain("--tabbar-h: calc(var(--touch-coarse) + 14px + env(safe-area-inset-bottom))");
  });

  test("with the keyboard up (short viewport) the tab bar and picker chrome give way to the composer", () => {
    const short = media(shellCss, "(max-width: 719px) and (max-height: 560px)");
    expect(short).toContain("--tabbar-h: 0px");
    expect(short).toContain(".tabbar { display: none; }");
    const compact = media(chatsCss, "(max-height: 560px)");
    expect(compact).toContain(".picker-label { position: absolute");
    expect(compact).toContain(".pickers-meta:not(:has(.picker-problem))");
  });

  test("iOS: the open-keyboard flag frees the composer, and fields never trigger focus zoom", () => {
    expect(chatsCss).toContain(":root[data-kb] .shell { --tabbar-h: 0px; }");
    expect(chatsCss).toContain(":root[data-kb] .chats-layout { min-height: 0; }");
    expect(chatsCss).toContain(":root[data-kb] .picker-label { position: absolute");
    expect(media(chatsCss, "(hover: none), (pointer: coarse), (max-width: 768px)")).toContain("body.chats-page :is(input, textarea, select) { font-size: 16px; }");
    expect(chatsCss).toContain(".msg-speak { width: 44px; height: 44px; min-height: 44px; }");
  });
});
