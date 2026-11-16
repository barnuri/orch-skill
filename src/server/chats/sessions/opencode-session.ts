import { withLanguageHint } from "../language";
import type { Launch } from "../options";
import { buildReplayPrompt } from "./history-replay";
import type { OpencodeServerPool } from "./opencode-server";
import { agentCouldNotRun, INTERRUPTED_TEXT, startTurn, TurnHandle, type TurnParser, tailTurn } from "./turn-files";
import { attachesNatively, type AgentEvent, type AgentSession, type SessionParams, type TurnInfo, withAttachments } from "./types";

const LOST_SESSION = /session|not found|no such|invalid|unknown|resume/i;
/** `run --server` could not reach the shared server (it died between `get()` and the turn): retry standalone. */
const SERVER_UNREACHABLE = /unable to connect|ECONNREFUSED|connection refused|fetch failed|requires a password|server at http/i;

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec {
  return typeof v === "object" && v !== null ? (v as Rec) : {};
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function summarize(input: unknown): string {
  const r = rec(input);
  for (const key of ["command", "filePath", "file_path", "path", "pattern", "url", "description", "query"]) {
    if (typeof r[key] === "string") {
      return (r[key] as string).slice(0, 200);
    }
  }
  return "";
}

type Usage = { input_tokens: number; output_tokens: number; cost_usd: number | null; model: string | null };
interface Outcome { error: string | null; streamed: boolean; sessionId: string | null; usage: Usage | null; couldNotRun: boolean; attached?: boolean }

/** Maps `opencode run --format json` lines to chat events; keeps what the retry logic and the closing events need. */
export class OpencodeParser implements TurnParser {
  readonly mode = "lines" as const;
  streamed = false;
  private error: string | null = null;
  private session: string | null;
  private input = 0;
  private output = 0;
  private cost: number | null = null;
  private seenUsage = false;

  constructor(sessionId: string | null, private readonly model: string | null) {
    this.session = sessionId;
  }

  sessionId(): string | null {
    return this.session;
  }

  feed(piece: string): AgentEvent[] {
    const out: AgentEvent[] = [];
    for (const line of piece.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      let ev: Rec;
      try {
        ev = rec(JSON.parse(line));
      } catch {
        continue;
      }
      if (typeof ev.sessionID === "string") {
        this.session = ev.sessionID;
      }
      const part = rec(ev.part);
      if (ev.type === "text" && typeof part.text === "string" && part.text !== "") {
        this.streamed = true;
        out.push({ type: "text-delta", text: part.text });
      } else if (ev.type === "tool_use") {
        this.streamed = true;
        const state = rec(part.state);
        const id = String(part.callID ?? part.id ?? "");
        out.push({ type: "tool", name: String(part.tool ?? "tool"), summary: summarize(state.input), id, input: state.input });
        if (state.status === "completed" || state.status === "error") {
          const output = typeof state.output === "string" ? state.output : typeof state.error === "string" ? state.error : "";
          out.push({ type: "tool-result", id, output, error: state.status === "error" });
        }
      } else if (ev.type === "reasoning" && typeof part.text === "string" && part.text !== "") {
        this.streamed = true;
        out.push({ type: "reasoning-delta", text: part.text });
      } else if (ev.type === "step_finish") {
        const tokens = rec(part.tokens);
        this.input += num(tokens.input);
        this.output += num(tokens.output);
        if (typeof part.cost === "number") {
          this.cost = (this.cost ?? 0) + part.cost;
        }
        this.seenUsage = true;
      } else if (ev.type === "error") {
        const e = rec(ev.error);
        const msg = rec(e.data).message ?? e.message ?? e.name;
        this.error = typeof msg === "string" && msg !== "" ? msg : JSON.stringify(ev.error).slice(0, 500);
      }
    }
    return out;
  }

  outcome(code: number, stderr: string): Outcome {
    let error = this.error;
    if (error === null && code !== 0) {
      const why = stderr.trim().slice(-500);
      error = `agent exited with code ${code}${why === "" ? "" : `: ${why}`}`;
    }
    return {
      error, streamed: this.streamed, sessionId: this.session, couldNotRun: agentCouldNotRun(code),
      usage: this.seenUsage ? { input_tokens: this.input, output_tokens: this.output, cost_usd: this.cost, model: this.model } : null,
    };
  }

  end(code: number, stderr: string): AgentEvent[] {
    const out = this.outcome(code, stderr);
    if (out.error !== null) {
      return [{ type: "error", message: out.error }];
    }
    const events: AgentEvent[] = [];
    if (out.usage !== null) {
      events.push({ type: "usage", ...out.usage });
    }
    if (out.sessionId === null) {
      events.push({ type: "warning", message: NO_SESSION_ID });
    }
    events.push({ type: "done", session_id: out.sessionId });
    return events;
  }
}

const NO_SESSION_ID = "opencode did not report its session id; later messages replay the conversation in the prompt.";
const FILES_ONLY_PROMPT = "See the attached files.";

/**
 * opencode as a chat harness (event shape verified against opencode 2.3.0 run output: `{type,timestamp,sessionID,part|error}`): each turn runs `opencode run --format json --auto [--session <id>] -m <model> [-f <file>]... <prompt>`
 * and maps its JSON lines (`text`, `tool_use`, `step_finish` with tokens and cost, `error`) to chat events.
 * The session id comes from the lines' `sessionID`, so the next turn resumes with `--session`. A stored id
 * opencode rejects starts a fresh session with the history replayed in the prompt, plus a warning.
 */
export class OpencodeSession implements AgentSession {
  readonly persistent = false;
  sessionId: string | null;
  private readonly handle = new TurnHandle();
  private attempt = 0;

  constructor(private readonly params: SessionParams, private readonly bin: string, private readonly launch: Launch, private readonly servers: OpencodeServerPool | null = null) {
    this.sessionId = params.resumeSessionId?.startsWith("ses") === true ? params.resumeSessionId : null;
  }

  async start(): Promise<void> {}

  async *send(prompt: string, attachments: readonly string[], turn?: TurnInfo): AsyncIterable<AgentEvent> {
    this.attempt = 0;
    yield* this.turn(prompt, attachments, turn?.messageId ?? `t-${crypto.randomUUID()}`);
  }

  private async *turn(prompt: string, attachments: readonly string[], turnId: string): AsyncIterable<AgentEvent> {
    const history = this.params.history?.() ?? [];
    let session = this.sessionId;
    let replay = session === null && history.length > 0;
    let standalone = false;
    for (let attempt = 0; ; attempt++) {
      // Images and text files go as `-f <path>` file parts (images become image input); other files stay a path
      // list in the prompt (see attachesNatively).
      // `opencode run` refuses files without a message ("You must provide a message"), so a files-only turn gets one.
      const parts = attachments.filter(attachesNatively);
      const body = withAttachments(prompt.trim() === "" && parts.length > 0 ? FILES_ONLY_PROMPT : prompt, attachments.filter((p) => !attachesNatively(p)));
      const text = replay ? buildReplayPrompt(history, body, this.params.replayBudget).prompt : body;
      const out = yield* this.once(session, text, parts, this.attempt++ === 0 ? turnId : `${turnId}.r${this.attempt - 1}`, turnId, standalone);
      if (out === null) {
        return;
      }
      if (out.error !== null && out.attached === true && !out.streamed && !standalone && SERVER_UNREACHABLE.test(out.error)) {
        standalone = true;
        attempt--;
        continue;
      }
      if (out.error !== null) {
        if (session !== null && attempt === 0 && !out.streamed && !out.couldNotRun && LOST_SESSION.test(out.error)) {
          session = null;
          this.sessionId = null;
          replay = true;
          yield { type: "warning", message: "The earlier opencode session could not be resumed, so this reply started a fresh one. The earlier messages are replayed in the prompt." };
          continue;
        }
        yield { type: "error", message: out.error };
        return;
      }
      if (out.sessionId !== null) {
        this.sessionId = out.sessionId;
      }
      if (out.usage !== null) {
        yield { type: "usage", ...out.usage };
      }
      if (this.sessionId === null) {
        yield { type: "warning", message: NO_SESSION_ID };
      }
      yield { type: "done", session_id: this.sessionId };
      return;
    }
  }

  private async *once(session: string | null, text: string, attachments: readonly string[], id: string, messageId: string, forceStandalone: boolean): AsyncGenerator<AgentEvent, Outcome | null> {
    const { launch } = this;
    const env: Record<string, string | undefined> = { ...process.env, ...launch.env, HARNESS_ORCH_HOME: this.params.home };
    // opencode 2.x rejects --pure. The turn attaches to this profile's long-lived `opencode serve` (started with the
    // same env, so it read the profile's OPENCODE_CONFIG_CONTENT; the shared background service would not). When that
    // server is down, `--standalone` starts a private one for this turn, as the dispatch.ts opencode adapter does.
    const target = { home: this.params.home, profile: this.params.profile, config: launch.env };
    const server = forceStandalone || this.servers === null ? null : await this.servers.get(this.bin, env, target);
    const args = ["run", "--format", "json", "--auto"];
    if (server === null) {
      args.push("--standalone");
    } else {
      args.push("--server", server.url);
      env.OPENCODE_SERVER_PASSWORD = server.password;
    }
    if (session !== null) {
      args.push("--session", session);
    }
    if (launch.modelSlug !== "") {
      args.push("-m", this.params.effort == null ? launch.modelSlug : `${launch.modelSlug}#${this.params.effort}`);
    }
    // `opencode run` has no --dir flag: the directory is the cwd of the spawned process (startTurn gets cwd below).
    args.push(...launch.flags.filter((flag) => flag !== "--pure" && flag !== "--standalone"));
    for (const path of attachments) {
      args.push("-f", path);
    }
    args.push(withLanguageHint(text));
    const signal = this.handle.begin();
    let started: ReturnType<typeof startTurn>;
    try {
      started = startTurn({
        home: this.params.home, id, cmd: [this.bin, ...args], cwd: this.params.cwd,
        env, stdin: null,
        meta: { harness: this.params.harness, parser: "opencode", session_id: session, chat_id: this.params.chatId, message_id: messageId, model: launch.modelSlug === "" ? null : launch.modelSlug },
      });
    } catch (err) {
      this.handle.end();
      return { error: `could not start the agent: ${String(err)}`, streamed: false, sessionId: null, usage: null, couldNotRun: true };
    }
    this.handle.attachPid(started.meta.pid);
    // The lease keeps the server up while this turn runs, across a dashboard restart too (dead pids drop out).
    if (server !== null) {
      this.servers?.lease(target, started.meta.pid);
    }
    const parser = new OpencodeParser(session, launch.modelSlug === "" ? null : launch.modelSlug);
    try {
      const end = yield* tailTurn(started.paths, started.meta, parser, { signal });
      if (end.kind === "aborted") {
        this.sessionId = parser.sessionId() ?? this.sessionId;
        return null;
      }
      if (end.kind === "interrupted") {
        yield { type: "interrupted", message: INTERRUPTED_TEXT };
        return null;
      }
      return { ...parser.outcome(end.code, end.stderr), attached: server !== null };
    } finally {
      if (server !== null && !signal.aborted) {
        // A detached tailer (dashboard shutdown) leaves the lease: the turn still runs on the server.
        this.servers?.release(target, started.meta.pid);
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
