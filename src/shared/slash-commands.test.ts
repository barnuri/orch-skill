import { describe, expect, test } from "bun:test";
import { filterMenu, insertMenuItem, menuAction, slashContext, SLASH_COMMANDS } from "./slash-commands";

const skills = [
  { name: "orch", description: "orchestrate work across harnesses" },
  { name: "ui-design", description: "design a UI in the user's taste" },
  { name: "xlsx", description: "spreadsheet files" },
];

describe("slashContext", () => {
  test("a slash in the first word is the first-word mode", () => {
    expect(slashContext("/sch", 4)).toEqual({ mode: "first", start: 0, query: "sch" });
    expect(slashContext("/", 1)).toEqual({ mode: "first", start: 0, query: "" });
  });

  test("the caret past the first word closes the first-word mode", () => {
    expect(slashContext("/loop ", 6)).toBeNull();
    expect(slashContext("/loop 10m", 9)).toBeNull();
  });

  test("a slash after whitespace is the mid-prompt mode", () => {
    expect(slashContext("summarise /ui", 13)).toEqual({ mode: "mid", start: 10, query: "ui" });
    expect(slashContext("a\n/x", 4)).toEqual({ mode: "mid", start: 2, query: "x" });
  });

  test("a slash inside a word, or a path, opens no menu", () => {
    expect(slashContext("see ~/sandbox/x", 15)).toBeNull();
    expect(slashContext("and/or", 6)).toBeNull();
  });
});

describe("filterMenu", () => {
  test("the first-word mode lists commands, then matching skills", () => {
    const rows = filterMenu({ mode: "first", start: 0, query: "" }, skills);
    expect(rows.slice(0, SLASH_COMMANDS.length).every((r) => r.kind === "command")).toBe(true);
    expect(rows.slice(SLASH_COMMANDS.length).map((r) => r.name)).toEqual(["orch", "ui-design", "xlsx"]);
  });

  test("the mid-prompt mode lists skills only", () => {
    const rows = filterMenu({ mode: "mid", start: 3, query: "" }, skills);
    expect(rows.every((r) => r.kind === "skill")).toBe(true);
    expect(rows.map((r) => r.usage)).toEqual(["/orch", "/ui-design", "/xlsx"]);
  });

  test("filters by typed text and puts prefix matches first", () => {
    expect(filterMenu({ mode: "first", start: 0, query: "sc" }, skills).map((r) => r.name)).toEqual(["schedule", "schedules"]);
    expect(filterMenu({ mode: "first", start: 0, query: "ui" }, skills).map((r) => r.name)).toEqual(["ui-design"]);
    expect(filterMenu({ mode: "first", start: 0, query: "harness" }, skills).map((r) => r.name)).toEqual(["orch"]);
    expect(filterMenu({ mode: "first", start: 0, query: "zzz" }, skills)).toEqual([]);
  });

  test("a command row carries its usage and description", () => {
    const [row] = filterMenu({ mode: "first", start: 0, query: "watch" }, []);
    expect(row).toEqual({ kind: "command", name: "watch", usage: "/watch <url|path|command>", description: expect.any(String) });
  });
});

describe("insertMenuItem", () => {
  test("replaces the typed command with the name and a space", () => {
    const text = "/sch";
    const next = insertMenuItem(text, 4, { mode: "first", start: 0, query: "sch" }, "schedule");
    expect(next).toEqual({ text: "/schedule ", caret: 10 });
  });

  test("inserts a mid-prompt skill and keeps the text after the caret", () => {
    const text = "run /ui and then";
    const next = insertMenuItem(text, 7, { mode: "mid", start: 4, query: "ui" }, "ui-design");
    expect(next).toEqual({ text: "run /ui-design and then", caret: 14 });
  });
});

describe("menuAction", () => {
  test("arrows move the highlight and wrap", () => {
    expect(menuAction("ArrowDown", 0, 3)).toEqual({ type: "move", index: 1 });
    expect(menuAction("ArrowDown", 2, 3)).toEqual({ type: "move", index: 0 });
    expect(menuAction("ArrowUp", 0, 3)).toEqual({ type: "move", index: 2 });
  });

  test("Enter and Tab pick the highlighted row", () => {
    expect(menuAction("Enter", 1, 3)).toEqual({ type: "pick", index: 1 });
    expect(menuAction("Tab", 0, 3)).toEqual({ type: "pick", index: 0 });
  });

  test("Escape closes, other keys are not menu keys, an empty menu takes no keys", () => {
    expect(menuAction("Escape", 0, 3)).toEqual({ type: "close" });
    expect(menuAction("a", 0, 3)).toBeNull();
    expect(menuAction("Enter", 0, 0)).toBeNull();
  });
});
