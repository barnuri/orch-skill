import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

import { buildReplayPrompt } from "./history-replay";
import { type AgentEvent, type AgentSession, Channel, drainText, type SessionParams, withAttachments } from "./types";

const TEMP_PREFIX = "orch-chat-";
const KILL_GRACE_MS = 1500;

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

/**
 * Fallback for harnesses without a persistent protocol: each turn runs `dispatch.sh run --profile P`
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
  private proc: Subprocess<"ignore", "pipe", "pipe"> | null = null;
  private stopping = false;

  constructor(private readonly params: SessionParams, private readonly dispatch: string) {
    this.sessionId = params.resumeSessionId;
  }

  async start(): Promise<void> {}

  async *send(prompt: string, attachments: readonly string[]): AsyncIterable<AgentEvent> {
    const dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
    try {
      yield* this.runTurn(dir, prompt, attachments);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private baseEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env, HARNESS_ORCH_HOME: this.params.home };
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

  private async *runTurn(dir: string, prompt: string, attachments: readonly string[]): AsyncIterable<AgentEvent> {
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
      const result = yield* this.runOnce(dir, text, env);
      if (result === null) {
        return;
      }
      if (result.code !== 0) {
        if (session !== null && attempt === 0 && !result.streamed && LOST_SESSION.test(result.stderr + result.stdout)) {
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
      yield { type: "done", session_id: id };
      return;
    }
  }

  /** One dispatch process. Returns null when the turn was stopped. */
  private async *runOnce(dir: string, text: string, env: Record<string, string | undefined>): AsyncGenerator<AgentEvent, TurnResult | null> {
    const file = join(dir, "prompt");
    writeFileSync(file, text, { mode: 0o600 });
    this.stopping = false;
    // detached: the child leads its own process group, so stop() can signal the agent dispatch.sh spawned too.
    const proc = Bun.spawn(["bash", this.dispatch, "run", "--profile", this.params.profile, `@${file}`], {
      cwd: this.params.cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true,
    });
    this.proc = proc;
    const channel = new Channel<string>();
    let stdout = "";
    let stderr = "";
    let streamed = false;
    const out = drainText(proc.stdout, (chunk) => {
      stdout += chunk;
      channel.push(chunk);
    }).finally(() => channel.close());
    void drainText(proc.stderr, (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    for (let chunk = await channel.next(); chunk !== null; chunk = await channel.next()) {
      streamed = true;
      yield { type: "text-delta", text: chunk };
    }
    await out;
    const code = await proc.exited;
    this.proc = null;
    return this.stopping ? null : { code, stdout, stderr, streamed };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.kill();
  }

  async dispose(): Promise<void> {
    this.stopping = true;
    await this.kill();
  }

  /** Signals the whole process group: dispatch.sh and the agent it started. */
  private signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  private async kill(): Promise<void> {
    const proc = this.proc;
    if (proc === null) {
      return;
    }
    const pid = proc.pid;
    this.signalGroup(pid, "SIGTERM");
    await proc.exited;
    const deadline = Date.now() + KILL_GRACE_MS;
    while (Date.now() < deadline && this.signalGroup(pid, 0)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    this.signalGroup(pid, "SIGKILL");
  }
}
