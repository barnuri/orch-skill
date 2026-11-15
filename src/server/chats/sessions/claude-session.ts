import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";

import type { Launch } from "../options";
import { type AgentEvent, type AgentSession, Channel, drainText, type SessionParams, withAttachments } from "./types";

type Line = Record<string, unknown> | null;

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

/**
 * One long-lived `claude -p --input-format stream-json` process per chat. Each turn writes one user
 * line to stdin and reads stdout until the `result` line. If the process dies (stop, crash, idle
 * dispose) the next turn starts a new one with `--resume <session id>`.
 */
export class ClaudeSession implements AgentSession {
  readonly persistent = true;
  sessionId: string | null;
  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private lines = new Channel<Line>();
  private stderrTail = "";
  private completedTurn: boolean;
  private stopping = false;

  constructor(
    private readonly params: SessionParams,
    private readonly bin: string,
    private readonly launch: Launch,
  ) {
    this.sessionId = params.resumeSessionId;
    this.completedTurn = params.resumeSessionId !== null;
  }

  async start(): Promise<void> {
    if (this.proc !== null) {
      return;
    }
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
    this.stderrTail = "";
    this.stopping = false;
    this.lines = new Channel<Line>();
    const channel = this.lines;
    const proc = Bun.spawn([this.bin, ...args], {
      cwd: params.cwd, env: { ...process.env, ...launch.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    this.proc = proc;
    let buffer = "";
    void drainText(proc.stdout, (text) => {
      buffer += text;
      let at = buffer.indexOf("\n");
      while (at >= 0) {
        const raw = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (raw !== "") {
          try {
            channel.push(JSON.parse(raw) as Record<string, unknown>);
          } catch {
            // not a protocol line (a stray log); ignore
          }
        }
        at = buffer.indexOf("\n");
      }
    }).finally(() => channel.close());
    void drainText(proc.stderr, (text) => {
      this.stderrTail = (this.stderrTail + text).slice(-2000);
    });
    void proc.exited.then(() => {
      if (this.proc === proc) {
        this.proc = null;
      }
    });
  }

  async *send(prompt: string, attachments: readonly string[]): AsyncIterable<AgentEvent> {
    await this.start();
    const proc = this.proc as Subprocess<"pipe", "pipe", "pipe">;
    const channel = this.lines;
    try {
      proc.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: withAttachments(prompt, attachments) }] } })}\n`);
      await proc.stdin.flush();
    } catch (err) {
      yield { type: "error", message: `could not write to the agent: ${String(err)}` };
      return;
    }
    let sawDelta = false;
    let model: string | null = null;
    for (;;) {
      const line = await channel.next();
      if (line === null) {
        if (!this.stopping) {
          const code = await proc.exited;
          yield { type: "error", message: `agent exited (code ${code}) before answering${this.stderrTail.trim() === "" ? "" : `: ${this.stderrTail.trim().slice(-500)}`}` };
        }
        return;
      }
      const type = line.type;
      if (type === "system" && line.subtype === "init" && typeof line.session_id === "string") {
        this.sessionId = line.session_id;
      } else if (type === "stream_event" && line.parent_tool_use_id == null) {
        const event = line.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
        if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
          sawDelta = true;
          yield { type: "text-delta", text: event.delta.text };
        }
      } else if (type === "assistant" && line.parent_tool_use_id == null) {
        const message = line.message as { model?: string; content?: Array<Record<string, unknown>> } | undefined;
        model = message?.model ?? model;
        for (const block of message?.content ?? []) {
          if (block.type === "tool_use") {
            yield { type: "tool", name: String(block.name ?? "tool"), summary: summarize(block.input) };
          } else if (block.type === "text" && !sawDelta && typeof block.text === "string") {
            yield { type: "text-delta", text: block.text };
          }
        }
      } else if (type === "result") {
        const usage = (line.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
        const used = Object.keys((line.modelUsage ?? {}) as object)[0] ?? model;
        yield {
          type: "usage", input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0,
          cost_usd: typeof line.total_cost_usd === "number" ? line.total_cost_usd : null, model: used ?? null,
        };
        if (typeof line.session_id === "string") {
          this.sessionId = line.session_id;
        }
        if (line.is_error === true) {
          yield { type: "error", message: String(line.result ?? "agent reported an error") };
        } else {
          this.completedTurn = true;
          yield { type: "done", session_id: this.sessionId };
        }
        return;
      }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.kill();
  }

  async dispose(): Promise<void> {
    this.stopping = true;
    await this.kill();
  }

  private async kill(): Promise<void> {
    const proc = this.proc;
    if (proc === null) {
      return;
    }
    this.proc = null;
    try {
      proc.stdin.end();
    } catch {
      // already closed
    }
    proc.kill("SIGTERM");
    const timer = setTimeout(() => proc.kill("SIGKILL"), 3000);
    await proc.exited;
    clearTimeout(timer);
  }
}
