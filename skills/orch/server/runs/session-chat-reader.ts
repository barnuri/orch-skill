import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ChatToolCall } from "../../shared/types/chat-tool-call";
import type { ChatTurn } from "../../shared/types/chat-turn";

export type ChatReadResult =
  | { kind: "ok"; turns: ChatTurn[]; truncated: boolean }
  | { kind: "missing" }
  | { kind: "invalid" };

/** One line of a harness transcript, reduced to the fields this reader consults. */
interface TranscriptLine {
  uuid?: unknown;
  type?: unknown;
  timestamp?: unknown;
  message?: { role?: unknown; content?: unknown };
}

/**
 * The conversation a node's harness actually had, read from the harness's own transcript.
 *
 * A node's job log holds only what the adapter printed — `claude -p --output-format text` emits
 * the final answer and nothing else — so the log can never show the session. Claude Code is the
 * one adapter orch hands a session id it chose (`--session-id`), and it writes that session to
 * `<claude home>/projects/<cwd slug>/<session>.jsonl`. The slug is derived from the working
 * directory, which orch does not record, so the file is found by scanning the project folders
 * for the session's own name — a session id is a UUID, so at most one can match.
 */
export class SessionChatReader {
  private static readonly TRANSCRIPT_SUFFIX: string = ".jsonl";
  private static readonly PROJECTS_DIR: string = "projects";
  private static readonly SESSION_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  /** Transcripts reach tens of megabytes; only the tail is worth reading for a session view. */
  private static readonly MAX_BYTES: number = 8 * 1024 * 1024;
  private static readonly SUMMARY_CHARS: number = 120;
  private static readonly ROLES: readonly string[] = ["user", "assistant"];

  private readonly claudeHome: string;

  constructor(claudeHome: string = SessionChatReader.defaultClaudeHome()) {
    this.claudeHome = claudeHome;
  }

  static defaultClaudeHome(): string {
    const configured = process.env["CLAUDE_CONFIG_DIR"];
    return configured !== undefined && configured !== "" ? configured : join(homedir(), ".claude");
  }

  private static isSessionId(value: string): boolean {
    return SessionChatReader.SESSION_ID.test(value);
  }

  private static textOf(block: Record<string, unknown>): string | null {
    const text = block["text"];
    return block["type"] === "text" && typeof text === "string" ? text : null;
  }

  /** The first string in the tool's input, which is the argument a reader wants to see. */
  private static summaryOf(input: unknown): string {
    if (typeof input !== "object" || input === null) {
      return "";
    }
    for (const value of Object.values(input as Record<string, unknown>)) {
      if (typeof value === "string" && value !== "") {
        return value.length > SessionChatReader.SUMMARY_CHARS
          ? `${value.slice(0, SessionChatReader.SUMMARY_CHARS)}…`
          : value;
      }
    }
    return "";
  }

  private static toolOf(block: Record<string, unknown>): ChatToolCall | null {
    const name = block["name"];
    if (block["type"] !== "tool_use" || typeof name !== "string") {
      return null;
    }
    return { name, summary: SessionChatReader.summaryOf(block["input"]) };
  }

  /**
   * A transcript line as a turn, or null when it carries nothing a reader would want: a
   * `thinking` block is private, and a line whose only content is `tool_result` is the harness
   * feeding a result back, not someone speaking. Dropping those is what keeps the view readable.
   */
  private static turnOf(line: TranscriptLine): ChatTurn | null {
    const role = line.type;
    if (typeof role !== "string" || !SessionChatReader.ROLES.includes(role)) {
      return null;
    }
    const content = line.message?.content;
    const id = typeof line.uuid === "string" ? line.uuid : "";
    const timestamp = typeof line.timestamp === "string" ? line.timestamp : null;
    const turnRole = role === "assistant" ? "assistant" : "user";
    if (typeof content === "string") {
      return content === "" ? null : { id, role: turnRole, timestamp, text: content, tools: [] };
    }
    if (!Array.isArray(content)) {
      return null;
    }
    const texts: string[] = [];
    const tools: ChatToolCall[] = [];
    for (const block of content) {
      if (typeof block !== "object" || block === null) {
        continue;
      }
      const record = block as Record<string, unknown>;
      const text = SessionChatReader.textOf(record);
      if (text !== null && text !== "") {
        texts.push(text);
      }
      const tool = SessionChatReader.toolOf(record);
      if (tool !== null) {
        tools.push(tool);
      }
    }
    if (texts.length === 0 && tools.length === 0) {
      return null;
    }
    return { id, role: turnRole, timestamp, text: texts.join("\n\n"), tools };
  }

  /** The transcript file for a session, or null when no project folder holds one. */
  transcriptPath(session: string): string | null {
    if (!SessionChatReader.isSessionId(session)) {
      return null;
    }
    const projects = join(this.claudeHome, SessionChatReader.PROJECTS_DIR);
    let entries: string[];
    try {
      entries = readdirSync(projects);
    } catch {
      return null;
    }
    const fileName = `${session}${SessionChatReader.TRANSCRIPT_SUFFIX}`;
    for (const entry of entries) {
      const candidate = join(projects, entry, fileName);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  read(session: string): ChatReadResult {
    if (!SessionChatReader.isSessionId(session)) {
      return { kind: "invalid" };
    }
    const path = this.transcriptPath(session);
    if (path === null) {
      return { kind: "missing" };
    }
    let text: string;
    let bytes: number;
    try {
      bytes = statSync(path).size;
      text = readFileSync(path, "utf8");
    } catch {
      return { kind: "missing" };
    }
    const truncated = bytes > SessionChatReader.MAX_BYTES;
    // Slicing the tail can land mid-line, so the first (partial) line is dropped with it.
    const lines = (truncated ? text.slice(-SessionChatReader.MAX_BYTES) : text).split("\n");
    const usable = truncated ? lines.slice(1) : lines;
    const turns: ChatTurn[] = [];
    for (const line of usable) {
      if (line.trim() === "") {
        continue;
      }
      let parsed: TranscriptLine;
      try {
        parsed = JSON.parse(line) as TranscriptLine;
      } catch {
        // One unreadable line must not lose the rest of the conversation.
        continue;
      }
      const turn = SessionChatReader.turnOf(parsed);
      if (turn !== null) {
        turns.push(turn);
      }
    }
    return { kind: "ok", turns, truncated };
  }
}
