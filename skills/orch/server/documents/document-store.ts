import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { writeAtomic } from "../files/atomic-write";

import type { DocumentKind } from "../../shared/types/document-kind";
import type { OrchPaths } from "../types/orch-paths";

const ETAG_ALGORITHM: string = "sha256";
const JSON_INDENT: number = 2;
const TRAILING_NEWLINE: string = "\n";

const ENUM_KEY_BY_KIND: Record<DocumentKind, "harnesses" | "outcomes"> = {
  profiles: "harnesses",
  memory: "outcomes",
};

export function documentPath(paths: OrchPaths, kind: DocumentKind): string {
  return paths[kind];
}

export function readDocumentBytes(paths: OrchPaths, kind: DocumentKind): Uint8Array {
  return new Uint8Array(readFileSync(documentPath(paths, kind)));
}

/** Strong ETag over the exact file bytes, so an unchanged file always yields a 304. */
export function etagOf(bytes: Uint8Array): string {
  return `"${createHash(ETAG_ALGORITHM).update(bytes).digest("hex")}"`;
}

export function enumKeyOf(kind: DocumentKind): "harnesses" | "outcomes" {
  return ENUM_KEY_BY_KIND[kind];
}

/**
 * Serialises like `jq` does for the bash CLI (2-space indent, trailing newline,
 * non-ASCII kept raw) and replaces the file atomically. Returns the written bytes
 * so the caller can derive the new ETag without re-reading the disk.
 */
export function writeDocument(paths: OrchPaths, kind: DocumentKind, document: unknown): Uint8Array {
  const text = JSON.stringify(document, null, JSON_INDENT) + TRAILING_NEWLINE;
  const bytes = new TextEncoder().encode(text);
  writeAtomic(paths.home, documentPath(paths, kind), bytes);
  return bytes;
}
