import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { TempHome } from "../test-support/temp-home";
import { discardToTrash, writeAtomic } from "./atomic-write";

const utf8: TextEncoder = new TextEncoder();
const TRASH_STAMP_PATTERN: RegExp = /^\d{8}T\d{6}Z$/;
const TMP_PATTERN: RegExp = /\.serve\.\d+\.\d+\.tmp$/;
const RUNNING_AS_ROOT: boolean = process.getuid?.() === 0;

let home: TempHome;

beforeEach(() => {
  home = TempHome.create();
});

afterEach(() => {
  home.dispose();
});

function tmpFilesIn(dir: string): string[] {
  return readdirSync(dir).filter((name) => TMP_PATTERN.test(name));
}

function trashStamps(): string[] {
  const trash = home.resolve(".trash");
  return existsSync(trash) ? readdirSync(trash) : [];
}

describe("writeAtomic", () => {
  test("replaces the content and keeps a trailing newline", () => {
    writeAtomic(home.path, home.resolve("memory.json"), utf8.encode('[{"ts":"x"}]\n'));
    expect(home.read("memory.json")).toBe('[{"ts":"x"}]\n');
  });

  test("preserves the target's existing mode", () => {
    chmodSync(home.resolve("profiles.json"), 0o600);
    writeAtomic(home.path, home.resolve("profiles.json"), utf8.encode("{}\n"));
    expect(home.mode("profiles.json")).toBe(0o600);
  });

  test("uses the default mode for a new file", () => {
    writeAtomic(home.path, home.resolve("serve/port"), utf8.encode("6724"));
    expect(home.mode("serve/port")).toBe(0o644 & ~umask());
  });

  test("leaves no temp file behind", () => {
    writeAtomic(home.path, home.resolve("memory.json"), utf8.encode("[]\n"));
    expect(tmpFilesIn(home.path)).toEqual([]);
  });

  test("moves the temp file under .trash/<stamp>/ when the rename fails", () => {
    const target = home.resolve("runs");
    expect(() => writeAtomic(home.path, target, utf8.encode("x"))).toThrow();
    expect(tmpFilesIn(home.path)).toEqual([]);
    const stamps = trashStamps();
    expect(stamps).toHaveLength(1);
    const stamp = stamps[0] ?? "";
    expect(stamp).toMatch(TRASH_STAMP_PATTERN);
    const trashed = readdirSync(home.resolve(join(".trash", stamp)));
    expect(trashed).toHaveLength(1);
    expect(trashed[0] ?? "").toMatch(TMP_PATTERN);
  });

  test.skipIf(RUNNING_AS_ROOT)("throws on a read-only directory without leaving a temp file", () => {
    const lockedDir = home.resolve("locked");
    mkdirSync(lockedDir, { mode: 0o500 });
    try {
      expect(() => writeAtomic(home.path, join(lockedDir, "file"), utf8.encode("x"))).toThrow();
      expect(tmpFilesIn(lockedDir)).toEqual([]);
    } finally {
      chmodSync(lockedDir, 0o700);
    }
  });
});

describe("discardToTrash", () => {
  test("moves the file into a fresh stamped directory", () => {
    const stray = home.resolve(".memory.json.serve.1.1.tmp");
    writeFileSync(stray, "half-written");
    discardToTrash(home.path, stray);
    expect(existsSync(stray)).toBe(false);
    const stamps = trashStamps();
    expect(stamps).toHaveLength(1);
    const moved = home.resolve(join(".trash", stamps[0] ?? "", ".memory.json.serve.1.1.tmp"));
    expect(statSync(moved).isFile()).toBe(true);
  });

  test("is a no-op for a missing path", () => {
    expect(() => discardToTrash(home.path, home.resolve("missing.tmp"))).not.toThrow();
    expect(trashStamps()).toEqual([]);
  });
});

function umask(): number {
  const current = process.umask();
  process.umask(current);
  return current;
}
