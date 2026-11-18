import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readCopilotServedModel } from "../served-model";
import { buildReplayPrompt } from "./history-replay";
import { agentCouldNotRun, INTERRUPTED_TEXT, startTurn, tailTurn, TurnHandle, type TurnParser, turnsDir } from "./turn-files";
import { type AgentEvent, type AgentSession, type SessionParams, type TurnInfo, withAttachments } from "./types";

const TEMP_PREFIX = "orch-chat-";

/** Removes `orch-chat-*` prompt folders a crashed server left behind. Returns how many. */
export function sweepPromptDirs(olderThanMs: number = 60 * 60 * 1000, dir: string = tmpdir(), nowMs: number = Date.now()): number {
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(TEMP_PREFIX)) {
        continue;
      }
      const path = join(dir, name);
      try {
        if (nowMs - statSync(path).mtimeMs > olderThanMs) {
          rmSync(path, { recursive: true, force: true });
          removed++;
        }
      } catch {
        // gone or not ours: skip
      }
    }
  } catch {
    // unreadable temp dir: nothing to sweep
  }
  return removed;
}

const LOST_SESSION = /session|chat|conversation|not found|no such|invalid|unknown|resume/i;
const CAPTURE_TIMEOUT_MS = 15_000;

interface TurnResult { code: number; stdout: string; stderr: string; streamed: boolean }

/** Plain text from `dispatch.ts run`: every piece is a text delta, exit code 0 is `done`. */
export class PlainParser implements TurnParser {
  readonly mode = "text" as const;
  stdout = "";
  streamed = false;

  constructor(private session: string | null) {}

  sessionId(): string | null {
    return this.session;
  }

  feed(piece: string): AgentEvent[] {
    this.stdout += piece;
    this.streamed = true;
    return [{ type: "text-delta", text: piece }];
  }

  end(code: number, stderr: string): AgentEvent[] {
    if (code === 0) {
      return [{ type: "done", session_id: this.session }];
    }
    const why = (stderr.trim() || this.stdout.trim()).slice(-500);
    return [{ type: "error", message: `agent exited with code ${code}${why === "" ? "" : `: ${why}`}` }];
  }
}

/**
 * Fallback for harnesses without a persistent protocol: each turn runs `dispatch.ts run --profile P`
 * (so profile env, flags and model resolve exactly as for any orch job). Output arrives as plain
 * text; there are no tool or usage events. Memory across turns, per harness:
 *  - copilot, pi: the dashboard mints the session id on turn 1 and resumes it afterwards.
 *  - cursor-agent: `cursor-agent create-chat` mints the id before turn 1.
 *  - opencode: turn 1 gets a title; the id opencode minted is read back from `opencode session list`.
 *  - local-llm, and any turn with no usable session id: the history is replayed in the prompt.
 * A stored id the harness no longer knows starts a fresh session, with a warning on the reply.
 * See skills/orch/references/chat-harnesses.md.
 */
export class TurnSession implements AgentSession {
  readonly persistent = false;
  sessionId: string | null;
  private readonly handle = new TurnHandle();

  get processId(): number | null {
    return this.handle.processId;
  }
  private attempt = 0;

  constructor(private readonly params: SessionParams, private readonly dispatch: string) {
    this.sessionId = params.resumeSessionId;
  }

  async start(): Promise<void> {}

  async *send(prompt: string, attachments: readonly string[], turn?: TurnInfo): AsyncIterable<AgentEvent> {
    this.attempt = 0;
    yield* this.runTurn(turn?.messageId ?? `t-${crypto.randomUUID()}`, prompt, attachments);
  }

  private baseEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env, HARNESS_ORCH_HOME: this.params.home, ORCH_USE: "chat" };
    if (this.params.modelId !== null) {
      env.ORCH_MODEL_ID = this.params.modelId;
    }
    if (this.params.harness === "pi") {
      env.ORCH_PI_SESSION_DIR = join(this.params.home, "chats", "pi-sessions");
    }
    return env;
  }

  /** Runs a small helper CLI (create-chat, session list) and returns its stdout, or null on any failure. */
  private async capture(cmd: string[], env: Record<string, string | undefined>): Promise<string | null> {
    try {
      const proc = Bun.spawn(cmd, { cwd: this.params.cwd, env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      const timer = setTimeout(() => proc.kill(), CAPTURE_TIMEOUT_MS);
      const out = await new Response(proc.stdout).text();
      const code = await proc.exited;
      clearTimeout(timer);
      return code === 0 ? out : null;
    } catch {
      return null;
    }
  }

  private async createCursorChat(env: Record<string, string | undefined>): Promise<string | null> {
    const out = await this.capture([Bun.which("cursor-agent", { PATH: env.PATH }) ?? "cursor-agent", "create-chat"], env);
    const id = out?.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
    return /^[A-Za-z0-9_-]{8,}$/.test(id) ? id : null;
  }

  private async findOpencodeSession(title: string, env: Record<string, string | undefined>): Promise<string | null> {
    const bin = Bun.which("opencode", { PATH: env.PATH }) ?? join(process.env.HOME ?? "", ".opencode", "bin", "opencode");
    const out = await this.capture([bin, "session", "list", "--format", "json", "-n", "50"], env);
    if (out === null) {
      return null;
    }
    try {
      const doc = JSON.parse(out) as unknown;
      const list = Array.isArray(doc) ? doc : ((doc as { sessions?: unknown }).sessions ?? []);
      for (const item of list as Array<{ id?: unknown; title?: unknown }>) {
        if (item.title === title && typeof item.id === "string") {
          return item.id;
        }
      }
    } catch {
      // not JSON: no id
    }
    return null;
  }

  private async *runTurn(turnId: string, prompt: string, attachments: readonly string[]): AsyncIterable<AgentEvent> {
    const { harness, chatId } = this.params;
    const history = this.params.history?.() ?? [];
    const title = `orch-chat-${chatId}`;
    let forceReplay = false;
    let session = this.sessionId;
    // opencode ids start with "ses"; anything else stored earlier (an orch-minted uuid) is not resumable.
    if (harness === "opencode" && session !== null && !session.startsWith("ses")) {
      session = null;
    }
    for (let attempt = 0; ; attempt++) {
      const env = this.baseEnv();
      let minted: string | null = session;
      if (session === null) {
        if (harness === "cursor-agent") {
          minted = await this.createCursorChat(env);
        } else if (harness === "opencode") {
          env.ORCH_SESSION_TITLE = title;
        } else if (harness !== "local-llm") {
          minted = crypto.randomUUID();
        }
      }
      // Without a session the model has no memory: replay the history instead.
      const replay = forceReplay || (minted === null && (harness === "cursor-agent" || harness === "opencode" || harness === "local-llm"));
      const built = replay ? buildReplayPrompt(history, withAttachments(prompt, attachments), this.params.replayBudget) : null;
      if (built?.truncated === true) {
        yield { type: "context-truncated" };
      }
      if (harness === "cursor-agent" && minted === null && history.length > 0) {
        yield { type: "warning", message: "Could not create a cursor-agent chat; earlier messages are replayed in the prompt instead." };
      }
      if (session !== null || harness === "cursor-agent") {
        if (minted !== null) {
          env.ORCH_RESUME_SESSION = minted;
        }
      } else if (minted !== null) {
        env.ORCH_SESSION_ID = minted;
      }
      const text = built?.prompt ?? withAttachments(prompt, attachments);
      const turnStart = Date.now() - 1000;
      const result = yield* this.runOnce(this.attempt++ === 0 ? turnId : `${turnId}.r${this.attempt - 1}`, turnId, text, env, minted);
      if (result === null) {
        return;
      }
      if (result.code !== 0) {
        if (session !== null && attempt === 0 && !result.streamed && !agentCouldNotRun(result.code) && LOST_SESSION.test(result.stderr + result.stdout)) {
          session = null;
          this.sessionId = null;
          yield { type: "warning", message: `The earlier ${harness} session could not be resumed, so this reply started a fresh one. The earlier messages are replayed in the prompt.` };
          forceReplay = true;
          continue;
        }
        const why = (result.stderr.trim() || result.stdout.trim()).slice(-500);
        yield { type: "error", message: `agent exited with code ${result.code}${why === "" ? "" : `: ${why}`}` };
        return;
      }
      let id = minted;
      if (harness === "opencode" && session === null) {
        id = await this.findOpencodeSession(title, env);
        if (id === null && history.length === 0) {
          yield { type: "warning", message: "opencode did not report its session id; later messages replay the conversation in the prompt." };
        }
      }
      this.sessionId = id;
      if (harness === "copilot" && id !== null) {
        const served = readCopilotServedModel(id, turnStart);
        if (served !== null) {
          yield { type: "served-model", model: served };
        }
      }
      yield { type: "done", session_id: id };
      return;
    }
  }

  /** One dispatch process, detached. Returns null when the turn was stopped or lost. */
  private async *runOnce(id: string, messageId: string, text: string, env: Record<string, string | undefined>, session: string | null): AsyncGenerator<AgentEvent, TurnResult | null> {
    const signal = this.handle.begin();
    let started: ReturnType<typeof startTurn>;
    try {
      const promptFile = join(turnsDir(this.params.home), `${id}.prompt`);
      mkdirSync(turnsDir(this.params.home), { recursive: true });
      writeFileSync(promptFile, text, { mode: 0o600 });
      started = startTurn({
        home: this.params.home, id, cmd: [process.execPath, this.dispatch, "run", "--profile", this.params.profile, `@${promptFile}`], cwd: this.params.cwd, env, stdin: null,
        meta: { harness: this.params.harness, parser: "plain", session_id: session, chat_id: this.params.chatId, message_id: messageId, model: this.params.modelId },
      });
    } catch (err) {
      this.handle.end();
      return { code: 1, stdout: "", stderr: `could not start the agent: ${String(err)}`, streamed: false };
    }
    this.handle.attachPid(started.meta.pid);
    const parser = new PlainParser(session);
    try {
      const end = yield* tailTurn(started.paths, started.meta, parser, { signal });
      if (end.kind === "aborted") {
        return null;
      }
      if (end.kind === "interrupted") {
        yield { type: "interrupted", message: INTERRUPTED_TEXT };
        return null;
      }
      return { code: end.code, stdout: parser.stdout, stderr: end.stderr, streamed: parser.streamed };
    } finally {
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
