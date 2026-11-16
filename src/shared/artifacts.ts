/** Artifact kinds and the shared event/reference shapes. Bun-free: used by the server and the web. */

export type ArtifactKind = "html" | "markdown" | "svg" | "image" | "mermaid" | "csv" | "json" | "pdf" | "tsx" | "code" | "text" | "unknown";

export const PREVIEW_LIMIT: number = 5 * 1024 * 1024;

const BY_EXT: Record<string, ArtifactKind> = {
  html: "html", htm: "html", md: "markdown", markdown: "markdown", svg: "svg",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
  mmd: "mermaid", mermaid: "mermaid", csv: "csv", tsv: "csv", json: "json", pdf: "pdf",
  tsx: "tsx", jsx: "tsx",
  ts: "code", js: "code", mjs: "code", py: "code", css: "code", sh: "code", go: "code", rs: "code", sql: "code", yml: "code", yaml: "code", xml: "code", java: "code", c: "code", cpp: "code", rb: "code",
  txt: "text", log: "text",
};

/** Extensions tracked for files an agent writes outside `artifacts/` (a Write or Edit tool call). */
export const DEFAULT_EXTERNAL_EXTENSIONS: readonly string[] = ["html", "md", "svg", "mmd", "csv", "json", "pdf", "tsx"];

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

export function kindOf(name: string): ArtifactKind {
  return BY_EXT[extOf(name)] ?? "unknown";
}

/** Kinds shown as text (code view, edit, diff, selection comments). */
export function isTextKind(kind: ArtifactKind): boolean {
  return kind !== "image" && kind !== "pdf" && kind !== "unknown";
}

export interface ArtifactVersion {
  n: number;
  at: string;
  turn: string | null;
  author: "agent" | "user" | "restore";
  hash: string;
  size: number;
}

export interface ArtifactInfo {
  name: string;
  kind: ArtifactKind;
  size: number;
  modified: string;
  version: number;
  hash: string;
}

export interface ArtifactEvent {
  chat_id: string;
  name: string;
  change: "created" | "updated" | "deleted";
  version: number;
  kind: ArtifactKind;
  hash: string;
  turn: string | null;
}

export interface ArtifactSettings {
  track_external: boolean;
  extensions: string[];
}

export interface ArtifactRef {
  name: string;
  version: number;
  hash: string;
  quote?: string;
  lines?: [number, number];
}

/** The text a reference adds to a message: path, version, hash and the instruction to edit in place. */
export function refBlock(refs: readonly ArtifactRef[], dir: string): string {
  if (refs.length === 0) {
    return "";
  }
  const lines = refs.map((r) => {
    const where = r.lines === undefined ? "" : r.lines[0] === r.lines[1] ? `, line ${r.lines[0]}` : `, lines ${r.lines[0]}-${r.lines[1]}`;
    const quote = r.quote === undefined || r.quote === "" ? "" : `\n> ${r.quote.replace(/\n/g, "\n> ")}`;
    return `- ${dir}/${r.name} (v${r.version}, hash ${r.hash}${where})${quote}`;
  });
  return `Artifact reference${refs.length > 1 ? "s" : ""}:\n${lines.join("\n")}\nEdit the file in place; the artifact panel updates live. If the hash differs from the file now, re-read it first.`;
}

/** `@name` tokens of a message that match an artifact name, in order, without duplicates. */
export function mentionedNames(text: string, names: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|\\s)@${escaped}(?=$|[\\s.,;:!?])`).test(text) && !out.includes(name)) {
      out.push(name);
    }
  }
  return out;
}
