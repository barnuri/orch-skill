import { withLanguageHint } from "../language";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Launch } from "../options";
import { startTurn, type TurnMeta, type TurnParser, type TurnPaths, TurnHandle, turnEvents } from "./turn-files";
import { type AgentEvent, type AgentSession, type SessionParams, type TurnInfo, withAttachments } from "./types";


function summarize(input: unknown): string {
  if (typeof input !== "object" || input === null) {
    return "";
  }
  const rec = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "url", "description", "query"]) {
    if (typeof rec[key] === "string") {
      return (rec[key] as string).slice(0, 200);
    }
  }
  return "";
}

function resultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === "object" && c !== null && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("");
  }
  return "";
}

/** Maps `claude -p --output-format stream-json` lines to chat events. Shared by the live turn and by boot recovery. */
export class ClaudeParser implements TurnParser {
  readonly mode = "lines" as const;
  done = false;
  private sawDelta = false;
  private sawThinking = false;
  private model: string | null = null;
  private session: string | null;

  constructor(sessionId: string | null) {
    this.session = sessionId;
  }

  sessionId(): string | null {
    return this.session;
  }

  feed(piece: string): AgentEvent[] {
    const out: AgentEvent[] = [];
    for (const raw of piece.split("\n")) {
      const text = raw.trim();
      if (text === "") {
        continue;
      }
      let line: Record<string, unknown>;
      try {
        line = JSON.parse(text) as Record<string, unknown>;
      } catch {
        continue; // not a protocol line (a stray log)
      }
      this.line(line, out);
    }
    return out;
  }

  private line(line: Record<string, unknown>, out: AgentEvent[]): void {
    const type = line.type;
    if (type === "system" && line.subtype === "init" && typeof line.session_id === "string") {
      this.session = line.session_id;
    } else if (type === "stream_event" && line.parent_tool_use_id == null) {
      const event = line.event as { type?: string; delta?: { type?: string; text?: string; thinking?: string } } | undefined;
      if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
        this.sawDelta = true;
        out.push({ type: "text-delta", text: event.delta.text });
      } else if (event?.type === "content_block_delta" && event.delta?.type === "thinking_delta" && typeof event.delta.thinking === "string") {
        this.sawThinking = true;
        out.push({ type: "reasoning-delta", text: event.delta.thinking });
      }
    } else if (type === "assistant" && line.parent_tool_use_id == null) {
      const message = line.message as { model?: string; content?: Array<Record<string, unknown>> } | undefined;
      this.model = message?.model ?? this.model;
      for (const block of message?.content ?? []) {
        if (block.type === "tool_use") {
          out.push({ type: "tool", name: String(block.name ?? "tool"), summary: summarize(block.input), id: String(block.id ?? ""), input: block.input });
        } else if (block.type === "thinking" && !this.sawThinking && typeof block.thinking === "string" && block.thinking !== "") {
          out.push({ type: "reasoning-delta", text: block.thinking });
        } else if (block.type === "text" && !this.sawDelta && typeof block.text === "string") {
          out.push({ type: "text-delta", text: block.text });
        }
      }
    } else if (type === "user" && line.parent_tool_use_id == null) {
      const message = line.message as { content?: unknown } | undefined;
      for (const block of Array.isArray(message?.content) ? (message.content as Array<Record<string, unknown>>) : []) {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          out.push({ type: "tool-result", id: block.tool_use_id, output: resultText(block.content), error: block.is_error === true });
        }
      }
    } else if (type === "result" && !this.done) {
      const usage = (line.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
      const used = Object.keys((line.modelUsage ?? {}) as object)[0] ?? this.model;
      out.push({
        type: "usage", input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0,
        cost_usd: typeof line.total_cost_usd === "number" ? line.total_cost_usd : null, model: used ?? null,
      });
      if (typeof line.session_id === "string") {
        this.session = line.session_id;
      }
      this.done = true;
      out.push(line.is_error === true ? { type: "error", message: String(line.result ?? "agent reported an error") } : { type: "done", session_id: this.session });
    }
  }

  end(code: number, stderr: string): AgentEvent[] {
    if (this.done) {
      return [];
    }
    const why = stderr.trim();
    return [{ type: "error", message: `agent exited (code ${code}) before answering${why === "" ? "" : `: ${why.slice(-500)}`}` }];
  }
}

/**
 * One `claude -p --input-format stream-json` process per turn, started detached with the prompt line in a file
 * it owns as stdin (see turn-files.ts), so a dashboard restart does not cut it. Every turn after the first
 * resumes the stored session with `--resume <session id>`.
 */
export class ClaudeSession implements AgentSession {
  readonly persistent = false;
  sessionId: string | null;
  private readonly handle = new TurnHandle();
  private completedTurn: boolean;

  constructor(

  get processId(): number | null {
    return this.handle.processId;
  }
    private readonly params: SessionParams,
    private readonly bin: string,
    private readonly launch: Launch,
  ) {
    this.sessionId = params.resumeSessionId;
    this.completedTurn = params.resumeSessionId !== null;
  }

  async start(): Promise<void> {}

  private args(): string[] {
    const { params, launch } = this;
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
    if (this.completedTurn && this.sessionId !== null) {
      args.push("--resume", this.sessionId);
    } else {
      this.sessionId = crypto.randomUUID();
      args.push("--session-id", this.sessionId);
    }
    if (launch.modelSlug !== "") {
      args.push("--model", launch.modelSlug);
      if (launch.behavesAs !== "") {
        const dir = join(params.home, "chats", "tmp");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `model-picker-${params.chatId}.json`);
        writeFileSync(file, JSON.stringify({ modelPicker: { options: [{ model: launch.modelSlug, label: launch.modelSlug, behavesAs: launch.behavesAs }] } }));
        args.push("--settings", file);
      }
    }
    args.push(...launch.flags);
    return args;
  }
    if (params.effort != null) {
      args.push("--effort", params.effort);
    }

  async *send(prompt: string, attachments: readonly string[], turn?: TurnInfo): AsyncIterable<AgentEvent> {
    const signal = this.handle.begin();
    const line = `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: withLanguageHint(withAttachments(prompt, attachments)) }] } })}\n`;
    let started: { paths: TurnPaths; meta: TurnMeta };
    try {
      started = startTurn({
        home: this.params.home, id: turn?.messageId ?? `t-${crypto.randomUUID()}`, cmd: [this.bin, ...this.args()], cwd: this.params.cwd,
        env: { ...process.env, ...this.launch.env }, stdin: line,
        meta: { harness: this.params.harness, parser: "claude", session_id: this.sessionId, chat_id: this.params.chatId, message_id: turn?.messageId ?? "", model: this.launch.modelSlug || null },
      });
    } catch (err) {
      this.handle.end();
      yield { type: "error", message: `could not start the agent: ${String(err)}` };
      return;
    }
    this.handle.attachPid(started.meta.pid);
    const parser = new ClaudeParser(this.sessionId);
    try {
      yield* turnEvents(started.paths, started.meta, parser, { signal });
    } finally {
      this.sessionId = parser.sessionId() ?? this.sessionId;
      if (parser.done) {
        this.completedTurn = true;
      }
      this.handle.end();
    }
  }

  async stop(): Promise<void> {
    await this.handle.stop();
  }

  async dispose(): Promise<void> {
    this.handle.detach();
  }
}
