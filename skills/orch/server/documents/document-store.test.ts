import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, readdirSync } from "node:fs";

import { orchPaths } from "../files/paths";
import { TempHome } from "../test-support/temp-home";
import {
  documentPath,
  enumKeyOf,
  etagOf,
  readDocumentBytes,
  writeDocument,
} from "./document-store";

import type { MemoryDocument } from "../../shared/types/memory-document";
import type { OrchPaths } from "../types/orch-paths";

const ETAG_PATTERN: RegExp = /^"[0-9a-f]{64}"$/;
const TMP_SUFFIX: string = ".tmp";
const RAW_NOTE: string = "résumé ✓";
const NON_ASCII_DOCUMENT: MemoryDocument = [
  { ts: "2026-09-03T10:00:00Z", profile: "claude", outcome: "success", note: RAW_NOTE },
];

function sha256Quoted(bytes: Uint8Array): string {
  return `"${createHash("sha256").update(bytes).digest("hex")}"`;
}

function tmpFilesIn(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(TMP_SUFFIX));
}

describe("document-store", () => {
  let home: TempHome;
  let paths: OrchPaths;

  beforeEach(() => {
    home = TempHome.create();
    paths = orchPaths(home.path);
  });

  afterEach(() => {
    home.dispose();
  });

  test("documentPath maps each kind to its file under home", () => {
    expect(documentPath(paths, "profiles")).toBe(home.resolve("profiles.json"));
    expect(documentPath(paths, "memory")).toBe(home.resolve("memory.json"));
  });

  test("enumKeyOf maps profiles to harnesses and memory to outcomes", () => {
    expect(enumKeyOf("profiles")).toBe("harnesses");
    expect(enumKeyOf("memory")).toBe("outcomes");
  });

  test("readDocumentBytes returns the seeded file bytes", () => {
    const expected = new Uint8Array(readFileSync(home.resolve("memory.json")));
    expect(readDocumentBytes(paths, "memory")).toEqual(expected);
  });

  test("etagOf is a quoted lowercase sha256 hex of the bytes", () => {
    const bytes = readDocumentBytes(paths, "profiles");
    const etag = etagOf(bytes);
    expect(etag).toMatch(ETAG_PATTERN);
    expect(etag).toBe(sha256Quoted(bytes));
  });

  test("etagOf changes when the bytes change", () => {
    const before = etagOf(readDocumentBytes(paths, "memory"));
    home.write("memory.json", '[{"ts":"x"}]\n');
    expect(etagOf(readDocumentBytes(paths, "memory"))).not.toBe(before);
  });

  test("writeDocument serialises with indent 2, trailing newline and raw non-ASCII", () => {
    const bytes = writeDocument(paths, "memory", NON_ASCII_DOCUMENT);
    const onDisk = home.read("memory.json");
    expect(onDisk).toBe(JSON.stringify(NON_ASCII_DOCUMENT, null, 2) + "\n");
    expect(onDisk).toContain(RAW_NOTE);
    expect(onDisk).not.toContain("\\u00e9");
    expect(new TextDecoder().decode(bytes)).toBe(onDisk);
  });

  test("writeDocument returns bytes whose etag matches the file on disk", () => {
    const bytes = writeDocument(paths, "profiles", { settings: {}, profiles: {} });
    expect(etagOf(bytes)).toBe(etagOf(readDocumentBytes(paths, "profiles")));
  });

  test("writeDocument preserves the target file mode", () => {
    chmodSync(home.resolve("profiles.json"), 0o600);
    writeDocument(paths, "profiles", { settings: {}, profiles: {} });
    expect(home.mode("profiles.json")).toBe(0o600);
  });

  test("writeDocument leaves no tmp file behind", () => {
    writeDocument(paths, "memory", []);
    expect(tmpFilesIn(home.path)).toEqual([]);
  });
});
