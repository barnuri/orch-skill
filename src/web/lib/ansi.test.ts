import { describe, expect, test } from "bun:test";
import { ansiSegments, stripAnsi, type AnsiSegment } from "./ansi";

function at(items: AnsiSegment[], i: number): AnsiSegment {
  const item = items[i];
  if (item === undefined) throw new Error(`no segment ${i}`);
  return item;
}

describe("ansiSegments", () => {
  test("plain text is one unstyled segment", () => {
    const seg = at(ansiSegments("hello"), 0);
    expect(seg.text).toBe("hello");
    expect(seg.style).toEqual({ base: null, rgb: null, bold: false, dim: false });
  });

  test("16 base colours, bright colours and reset", () => {
    const segs = ansiSegments("\x1b[31mred\x1b[0m plain \x1b[92mbright\x1b[39m");
    expect(segs.map((s) => s.text)).toEqual(["red", " plain ", "bright"]);
    expect(at(segs, 0).style.base).toBe(1);
    expect(at(segs, 1).style.base).toBeNull();
    expect(at(segs, 2).style.base).toBe(10);
  });

  test("bold, dim and their reset", () => {
    const segs = ansiSegments("\x1b[1;2mx\x1b[22my");
    expect(at(segs, 0).style).toMatchObject({ bold: true, dim: true });
    expect(at(segs, 1).style).toMatchObject({ bold: false, dim: false });
  });

  test("256 colours map the base range to a base index and the cube to rgb", () => {
    const segs = ansiSegments("\x1b[38;5;3mA\x1b[38;5;196mB\x1b[38;5;232mC");
    expect(at(segs, 0).style.base).toBe(3);
    expect(at(segs, 1).style).toMatchObject({ base: null, rgb: "rgb(255,0,0)" });
    expect(at(segs, 2).style.rgb).toBe("rgb(8,8,8)");
  });

  test("truecolor", () => {
    const seg = at(ansiSegments("\x1b[38;2;10;20;30mT"), 0);
    expect(seg.style.rgb).toBe("rgb(10,20,30)");
  });

  test("background colours and unknown codes are ignored", () => {
    const segs = ansiSegments("\x1b[41;5mtext\x1b[?25l\x1b]0;title\x07");
    expect(segs.map((s) => s.text)).toEqual(["text"]);
    expect(at(segs, 0).style).toMatchObject({ base: null, rgb: null });
  });

  test("text that looks like HTML stays text (no markup is produced)", () => {
    const segs = ansiSegments("\x1b[32m<script>alert(1)</script>");
    expect(at(segs, 0).text).toBe("<script>alert(1)</script>");
  });

  test("carriage returns are dropped", () => {
    expect(ansiSegments("a\r\nb").map((s) => s.text).join("")).toBe("a\nb");
  });
});

describe("stripAnsi", () => {
  test("removes colour codes", () => {
    expect(stripAnsi("\x1b[91m\x1b[1mError:\x1b[0m")).toBe("Error:");
  });
});
