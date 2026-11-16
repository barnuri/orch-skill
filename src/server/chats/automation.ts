import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { dirname, join } from "node:path";

import {
  type AutomationMode, LIMITS, type MonitorSpec, RESULT_TITLE, SCHEDULED_PREFIX, isLinkLocalIp, urlProblem,
} from "../../shared/chat-automation";
import type { AutomationPart } from "../../shared/chat-parts";
import { type PushCategory, chatUrl, notificationBody, redactSecrets } from "../../shared/push";
import type { ChatLoop, ChatMonitor, ItemStatus, LogEntry, MonitorThen } from "../../shared/types/chat-automation";
import type { Schedule } from "../../shared/types/schedule";
import { dispatchPath } from "../dispatch-path";
import type { NotifyInput } from "../push/hub";
import { readSchedules } from "../schedules/schedule-reader";
import type { ServerContext } from "../types/server-context";
import { pushHubFor } from "../push/hub";
import { HttpError, chatServiceFor } from "./service";
import type { ChatService } from "./service";

export interface Spawned { code: number; out: string; err: string }
export type Runner = (args: readonly string[]) => Promise<Spawned>;
export type Notifier = (category: PushCategory, input: NotifyInput) => Promise<unknown>;

export interface AutomationOptions {
  home: string;
  now?: () => number;
  notify?: Notifier;
  run?: Runner;
  /** How often a waiting fire looks at the chat (ms). */
  pollMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const SHELL_QUOTE = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const REPLY_WAIT_MS = 2 * 3600_000;
const POST_MAX = 6000;

function readJson<T = Record<string, any>>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function dirsIn(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export function dispatchRunner(home: string): Runner {
  return async (args) => {
    const proc = Bun.spawn([process.execPath, dispatchPath(), ...args], { env: { ...process.env, HARNESS_ORCH_HOME: home }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, out, err };
  };
}

/** The smallest check interval a monitor type may use; ORCH_EVERY_MIN_SECS lowers it for tests only. */
export function minInterval(type: MonitorSpec["type"]): number {
  const override = Number(process.env["ORCH_EVERY_MIN_SECS"]);
  if (override >= 1) {
    return override;
  }
  return type === "url" ? LIMITS.minUrlSecs : LIMITS.minLocalSecs;
}

/** The shell command a monitor runs, and the flags that go with it. Nothing but the configured URL is ever fetched. */
export function monitorCommand(spec: MonitorSpec, home: string): { cmd: string; match: string; baseline: boolean; stream: boolean; describe: string } {
  const t = spec.target;
  const cond = spec.condition ?? "";
  switch (spec.type) {
    case "file":
      return {
        cmd: `p=${SHELL_QUOTE(t)}; if [ -d "$p" ]; then find "$p" -type f -exec cksum {} + 2>/dev/null | sort | cksum; else cksum "$p" 2>&1; fi`,
        match: "", baseline: true, stream: false, describe: `${t} changed`,
      };
    case "url": {
      const curl = `curl -s -m 20 --max-redirs 0 --proto '=http,https' --proto-redir '=http,https'`;
      if (cond === "text") {
        return { cmd: `${curl} ${SHELL_QUOTE(t)} | cksum`, match: "", baseline: true, stream: false, describe: `${t} text changed` };
      }
      return { cmd: `${curl} -o /dev/null -w 'HTTP %{http_code}' ${SHELL_QUOTE(t)}`, match: spec.pattern ?? "", baseline: spec.pattern === undefined, stream: false, describe: t };
    }
    case "command":
      if (cond === "regex") {
        return { cmd: `${t} 2>&1`, match: spec.pattern ?? ".", baseline: false, stream: false, describe: `\`${t}\` matched` };
      }
      return { cmd: `( ${t} ) >/dev/null 2>&1; echo "exit $?"`, match: spec.pattern ?? "", baseline: true, stream: false, describe: `\`${t}\` exit code changed` };
    case "stream":
      return { cmd: t, match: spec.pattern ?? "", baseline: false, stream: true, describe: `\`${t}\` printed` };
    case "run":
      return {
        cmd: `grep -o '"status": *"[^"]*"' ${SHELL_QUOTE(join(home, "runs", t, "state.json"))} | head -1`,
        match: spec.pattern ?? "done|error|failed|stopped|stalled", baseline: false, stream: false, describe: `Run ${t}`,
      };
    case "git":
      if (cond === "ci") {
        return { cmd: `cd ${SHELL_QUOTE(t)} && ghx run list -L1 --json status,conclusion --jq '.[0]|"\\(.status) \\(.conclusion)"'`, match: "", baseline: true, stream: false, describe: `CI in ${t}` };
      }
      return { cmd: `git -C ${SHELL_QUOTE(t)} fetch -q 2>/dev/null; git -C ${SHELL_QUOTE(t)} log -1 --format='%h %s' '@{u}' 2>/dev/null || git -C ${SHELL_QUOTE(t)} log -1 --format='%h %s'`, match: "", baseline: true, stream: false, describe: `New commit in ${t}` };
  }
}

export interface MonitorInput {
  name: string;
  spec: MonitorSpec;
  /** Seconds between checks (ignored for a stream). */
  every?: number;
  once?: boolean;
  debounce?: number;
  /** Seconds until the monitor ends by itself. */
  expires_in?: number;
  then?: MonitorThen;
}

export interface LoopInput {
  label: string;
  prompt: string;
  /** Seconds between iterations; "when done" is the 10 s minimum. */
  every: number;
  max?: number;
  mode?: AutomationMode;
  until_command?: string;
  until_regex?: string;
  until_text?: string;
  max_runtime?: number;
}

export interface ScheduleCreate {
  name: string;
  prompt: string;
  cron: string;
  timezone?: string;
  mode?: AutomationMode;
  enabled?: boolean;
  once?: boolean;
}

interface Cursors { loops: Record<string, { iter: number; ended: boolean }>; watches: Record<string, { n: number; ended: boolean; lastPost: number; held: number; heldText: string }> }

/**
 * Everything that makes a chat the home of schedules, loops and monitors. The engines are the existing ones
 * (`schedule`, `loop`, `watch` of dispatch.ts, the only writers of their state); this class adds what only the
 * dashboard can do: send into a chat, post results into the thread, mark it unread and push.
 */
export class ChatAutomation {
  private readonly home: string;
  private readonly now: () => number;
  private readonly run: Runner;
  private readonly notify: Notifier;
  private readonly pollMs: number;
  private readonly firing = new Set<string>();
  private cursors: Cursors;
  private readonly cursorFile: string;

  constructor(private readonly service: ChatService, opts: AutomationOptions) {
    this.home = opts.home;
    this.now = opts.now ?? Date.now;
    this.run = opts.run ?? dispatchRunner(opts.home);
    this.notify = opts.notify ?? (async () => undefined);
    this.pollMs = opts.pollMs ?? 500;
    this.cursorFile = join(opts.home, "chats", "automation-cursors.json");
    this.cursors = readJson<Cursors>(this.cursorFile) ?? { loops: {}, watches: {} };
  }

  private saveCursors(): void {
    mkdirSync(dirname(this.cursorFile), { recursive: true });
    writeFileSync(this.cursorFile, JSON.stringify(this.cursors));
  }

  /** dispatch.ts exits 2 for a bad argument (400) and 1 for a refused state such as a limit (409). */
  private ok(res: Spawned): Spawned {
    if (res.code !== 0) {
      const text = res.err.trim() || res.out.trim() || `dispatch exited ${res.code}`;
      throw new HttpError(text.startsWith("unknown ") ? 404 : res.code === 2 ? 400 : res.code === 1 ? 409 : 500, text);
    }
    return res;
  }

  private graceMs(): number {
    const hours = Number(readJson<{ settings?: { schedule_grace_hours?: number } }>(join(this.home, "profiles.json"))?.settings?.schedule_grace_hours);
    return (hours > 0 ? hours : LIMITS.graceHoursDefault) * 3600_000;
  }

  private allowLinkLocal(): boolean {
    return readJson<{ settings?: { monitor_allow_link_local?: boolean } }>(join(this.home, "profiles.json"))?.settings?.monitor_allow_link_local === true;
  }

  private tell(chatId: string, body: string, key: string, category: PushCategory = "schedules"): void {
    const title = this.service.store.getChat(chatId)?.title || "Orch";
    void this.notify(category, { title, body: notificationBody(redactSecrets(body)), tag: `chat:${chatId}`, url: chatUrl(chatId), chatId, waiting: true }).catch(() => {});
    void key;
  }

  // ---------------------------------------------------------------- schedules

  schedulesOf(chatId: string): Schedule[] {
    return readSchedules(this.home).filter((s) => s.target?.chat_id === chatId);
  }

  private scheduleOf(chatId: string, sid: string): Schedule {
    const s = readSchedules(this.home).find((x) => x.id === sid);
    if (s === undefined || s.target?.chat_id !== chatId) {
      throw new HttpError(404, `unknown schedule: ${sid}`);
    }
    return s;
  }

  /** The chat id, after checking it exists (404 otherwise). */
  known(chatId: string): string {
    this.service.chat(chatId);
    return chatId;
  }

  markRead(chatId: string): void {
    this.service.markRead(chatId);
  }

  async createSchedule(chatId: string, input: ScheduleCreate): Promise<{ id: string }> {
    const chat = this.service.chat(chatId);
    if (chat.archived_at !== null) {
      throw new HttpError(409, "chat is archived");
    }
    const args = ["schedule", "add", "--chat", chatId, "--mode", input.mode ?? "message", "--name", input.name, "--cron", input.cron, "--prompt", input.prompt];
    if (input.timezone !== undefined && input.timezone !== "") {
      args.push("--tz", input.timezone);
    }
    if (input.once === true) {
      args.push("--once");
    }
    const id = this.ok(await this.run(args)).out.trim();
    if (input.enabled === false) {
      this.ok(await this.run(["schedule", "disable", id]));
    }
    return { id };
  }

  async editSchedule(chatId: string, sid: string, patch: Partial<Pick<ScheduleCreate, "name" | "prompt" | "cron" | "timezone" | "mode">> & { enabled?: boolean }): Promise<void> {
    this.scheduleOf(chatId, sid);
    const args = ["schedule", "edit", sid];
    const map: Array<[string, string | undefined]> = [["--name", patch.name], ["--prompt", patch.prompt], ["--cron", patch.cron], ["--tz", patch.timezone], ["--mode", patch.mode]];
    for (const [flag, value] of map) {
      if (value !== undefined) {
        args.push(flag, value);
      }
    }
    if (args.length > 3) {
      this.ok(await this.run(args));
    }
    if (patch.enabled !== undefined) {
      this.ok(await this.run(["schedule", patch.enabled ? "enable" : "disable", sid]));
    }
  }

  async setScheduleEnabled(chatId: string, sid: string, enabled: boolean): Promise<void> {
    await this.editSchedule(chatId, sid, { enabled });
  }

  async deleteSchedule(chatId: string, sid: string): Promise<void> {
    this.scheduleOf(chatId, sid);
    this.ok(await this.run(["schedule", "remove", sid]));
  }

  scheduleLog(chatId: string, sid: string): LogEntry[] {
    return this.scheduleOf(chatId, sid).runs.slice(0, 20).map((r) => ({ at: r.started_at, status: r.status, text: r.error ?? r.note ?? "", message_id: r.message_id ?? null }));
  }

  /** Fires a schedule once, outside its timetable, and resolves when its run is recorded. */
  async runNow(chatId: string, sid: string): Promise<void> {
    const s = this.scheduleOf(chatId, sid);
    if (this.service.chat(chatId).archived_at !== null) {
      throw new HttpError(409, "chat is archived");
    }
    await this.fire(s, { advance: false });
  }

  private async record(id: string, status: "ok" | "failed" | "skipped", f: { messageId?: string | null; ms?: number; error?: string | null; note?: string; advance?: boolean }): Promise<void> {
    const args = ["schedule", "record", id, "--status", status, "--at", String(Math.floor(this.now() / 1000))];
    if (f.messageId) args.push("--message-id", f.messageId);
    if (f.ms !== undefined) args.push("--duration-ms", String(Math.round(f.ms)));
    if (f.error) args.push("--error", f.error.slice(0, 500));
    if (f.note) args.push("--note", f.note);
    if (f.advance) args.push("--advance");
    await this.run(args);
  }

  private async waitReply(chatId: string, userMessageId: string): Promise<{ id: string | null; status: string; error: string | null }> {
    const deadline = this.now() + REPLY_WAIT_MS;
    for (;;) {
      const reply = this.service.store.messagesAfter(chatId, userMessageId).find((m) => m.role === "assistant");
      if (reply !== undefined && reply.status !== "streaming" && reply.status !== "pending") {
        return { id: reply.id, status: reply.status, error: reply.error };
      }
      if (this.now() > deadline) {
        return { id: reply?.id ?? null, status: "error", error: "no answer within 2 hours" };
      }
      await sleep(this.pollMs);
    }
  }

  private async fire(s: Schedule, opts: { advance: boolean }): Promise<void> {
    const target = s.target;
    if (target === undefined || this.firing.has(s.id)) {
      return;
    }
    this.firing.add(s.id);
    const started = this.now();
    let messageId: string | null = null;
    let error: string | null = null;
    try {
      if (target.mode === "message") {
        const sent = this.service.submit(target.chat_id, { content: `${SCHEDULED_PREFIX}${s.name}\n\n${s.prompt ?? ""}` });
        let userId: string | null;
        if (sent.queued) {
          userId = null;
          for (;;) {
            const row = this.service.queue.find(target.chat_id, sent.item.id);
            if (row === null || row.state === "cancelled") {
              error = "the queued message was cancelled";
              break;
            }
            if (row.state === "sent" || row.state === "running") {
              userId = row.message_id;
              if (userId !== null) break;
            }
            await sleep(this.pollMs);
          }
        } else {
          userId = sent.user_message_id;
        }
        if (userId !== null) {
          const reply = await this.waitReply(target.chat_id, userId);
          messageId = reply.id;
          error = reply.status === "done" ? null : reply.error ?? `the reply ${reply.status}`;
        }
        if (error !== null) {
          this.tell(target.chat_id, `${RESULT_TITLE}${s.name} failed: ${error}`, s.id);
        } else {
          this.tell(target.chat_id, `${RESULT_TITLE}${s.name}`, s.id);
        }
        this.service.store.setUnread(target.chat_id, true);
      } else {
        const result = await this.service.runIsolated(target.chat_id, s.prompt ?? "");
        error = result.error ?? (result.text === "" ? "the agent returned nothing" : null);
        const part: AutomationPart = { type: "automation", kind: "schedule", level: error === null ? "result" : "error", title: `${RESULT_TITLE}${s.name}`, item_id: s.id, link: "#/schedules" };
        const row = this.service.postBlock(target.chat_id, { content: error === null ? result.text : `The run failed: ${error}`, part, failed: error !== null });
        messageId = row.id;
        this.tell(target.chat_id, error === null ? `${RESULT_TITLE}${s.name}: ${result.text}` : `${RESULT_TITLE}${s.name} failed: ${error}`, s.id);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    try {
      await this.finish(s, target.chat_id, { messageId, ms: this.now() - started, error, advance: opts.advance });
    } finally {
      this.firing.delete(s.id);
    }
  }

  private async finish(s: Schedule, chatId: string, f: { messageId: string | null; ms: number; error: string | null; advance: boolean }): Promise<void> {
    const { messageId, error } = f;
    const target = { chat_id: chatId };
    await this.record(s.id, error === null ? "ok" : "failed", { messageId, ms: f.ms, error, advance: f.advance });
    if (error !== null) {
      const after = readSchedules(this.home).find((x) => x.id === s.id);
      if (after !== undefined && !after.enabled && (after.pause_reason ?? "").startsWith("paused after")) {
        this.service.postBlock(target.chat_id, {
          content: `${after.pause_reason}. Resume it from the Schedules list when the cause is fixed.`,
          part: { type: "automation", kind: "schedule", level: "error", title: `Schedule paused: ${s.name}`, item_id: s.id },
          failed: true,
        });
        this.tell(target.chat_id, `Schedule paused: ${s.name}`, s.id);
      }
    }
  }

  /**
   * One pass over every enabled chat schedule: pauses those of an archived chat, fires a retry that is due, and fires
   * a due run once. A run missed while the server was down fires once if it is inside the grace window, else it is
   * skipped and logged. The claim file makes a fire happen once even with two servers or a double tick.
   */
  async evaluate(): Promise<void> {
    const nowMs = this.now();
    for (const s of readSchedules(this.home)) {
      if (s.target?.kind !== "chat" || !s.enabled) {
        continue;
      }
      const chat = this.service.store.getChat(s.target.chat_id);
      if (chat === null || chat.archived_at !== null) {
        await this.run(["schedule", "pause", s.id, "the chat was archived"]);
        continue;
      }
      if (typeof s.retry_at === "number" && s.retry_at * 1000 <= nowMs) {
        const claim = this.claim(s.id, `retry-${s.retry_at}`);
        if (claim) {
          void this.fire(s, { advance: false });
        }
        continue;
      }
      const next = s.next_at ?? 0;
      if (!(next > 0 && next * 1000 <= nowMs) || this.firing.has(s.id)) {
        continue;
      }
      if (!this.claim(s.id, String(next))) {
        continue;
      }
      if (nowMs - next * 1000 > this.graceMs()) {
        await this.record(s.id, "skipped", { note: `missed ${new Date(next * 1000).toISOString()}: outside the ${this.graceMs() / 3600_000} h grace window`, advance: true });
        continue;
      }
      void this.fire(s, { advance: true });
    }
  }

  private claim(id: string, key: string): boolean {
    const dir = join(this.home, "schedules", id, "claims");
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, key), JSON.stringify({ fire: `${id}@${key}`, claimed_at: this.now() }), { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  }

  private timers: Array<ReturnType<typeof setInterval>> = [];

  /** Evaluates schedules every 30 s and bridges loop and monitor results every 2 s. */
  start(): void {
    if (this.timers.length > 0) return;
    const guard = (fn: () => Promise<void>) => () => void fn().catch((err) => process.stderr.write(`chat automation: ${err instanceof Error ? err.message : String(err)}\n`));
    const first = setTimeout(guard(() => this.evaluate()), 5000);
    first.unref();
    this.timers = [setInterval(guard(() => this.evaluate()), 30_000), setInterval(guard(() => this.poll()), 2000)];
    for (const t of this.timers) t.unref();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Waits for the fires started by `evaluate` (tests, shutdown). */
  async idle(): Promise<void> {
    for (let i = 0; i < 2000 && this.firing.size > 0; i++) {
      await sleep(10);
    }
  }

  // ---------------------------------------------------------------- loops

  private loopFiles(id: string): { spec: Record<string, any>; state: Record<string, any> } | null {
    const dir = join(this.home, "loops", id);
    const spec = readJson(join(dir, "spec.json"));
    const state = readJson(join(dir, "state.json"));
    return spec === null || state === null ? null : { spec, state };
  }

  private pidAlive(pid: unknown): boolean {
    if (typeof pid !== "number" || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err instanceof Error && "code" in err && err.code === "EPERM";
    }
  }

  private loopView(id: string): ChatLoop | null {
    const f = this.loopFiles(id);
    if (f === null || f.spec["target"]?.kind !== "chat") return null;
    const { spec, state } = f;
    const status: ItemStatus = state["status"] === "running" && !this.pidAlive(state["pid"]) && state["demo"] !== true ? "lost" : (state["status"] as ItemStatus);
    return {
      id, label: spec["label"] || spec["name"] || id, prompt: readText(join(this.home, "loops", id, "prompt.txt")), mode: spec["target"].mode ?? "message", status,
      reason: state["reason"] ?? null, iteration: Number(state["iteration"] ?? 0), max: Number(spec["max"] ?? 0), interval: Number(spec["interval"] ?? 0),
      next_tick: Number(state["next_tick"] ?? 0), until: { command: spec["until"] ?? "", regex: spec["until_re"] ?? "", text: spec["until_text"] ?? "" },
      last_exit: typeof state["last_exit"] === "number" ? state["last_exit"] : null, started: spec["started"] ?? "", ended: state["ended"] ?? null,
    };
  }

  loopsOf(chatId: string): ChatLoop[] {
    return dirsIn(join(this.home, "loops"))
      .filter((id) => this.loopFiles(id)?.spec["target"]?.chat_id === chatId)
      .map((id) => this.loopView(id))
      .filter((l): l is ChatLoop => l !== null)
      .sort((a, b) => b.started.localeCompare(a.started) || b.id.localeCompare(a.id));
  }

  private loopOf(chatId: string, id: string): ChatLoop {
    const l = this.loopFiles(id)?.spec["target"]?.chat_id === chatId ? this.loopView(id) : null;
    if (l === null) throw new HttpError(404, `unknown loop: ${id}`);
    return l;
  }

  async createLoop(chatId: string, input: LoopInput): Promise<{ id: string }> {
    const chat = this.service.chat(chatId);
    if (chat.archived_at !== null) throw new HttpError(409, "chat is archived");
    const cwd = this.service.effectiveCwd(chat);
    const args = ["loop", "start", "--every", `${Math.max(1, Math.round(input.every))}s`, "--max", String(input.max ?? 0), "--chat", chatId, "--mode", input.mode ?? "message", "--label", input.label];
    if (input.until_command) args.push("--until", input.until_command);
    if (input.until_regex) args.push("--until-re", input.until_regex);
    if (input.until_text) args.push("--until-text", input.until_text);
    if (input.max_runtime) args.push("--max-runtime", `${Math.round(input.max_runtime)}s`);
    if (cwd) args.push("--cwd", cwd);
    args.push("--profile", chat.profile, input.prompt);
    return { id: this.ok(await this.run(args)).out.trim() };
  }

  async stopLoop(chatId: string, id: string): Promise<void> {
    this.loopOf(chatId, id);
    this.ok(await this.run(["loop", "stop", id]));
  }

  async resumeLoop(chatId: string, id: string): Promise<void> {
    this.loopOf(chatId, id);
    this.ok(await this.run(["loop", "resume", id]));
  }

  loopLog(chatId: string, id: string): LogEntry[] {
    const l = this.loopOf(chatId, id);
    const out: LogEntry[] = [];
    for (let n = l.iteration; n >= 1 && out.length < 20; n--) {
      out.push({ at: "", status: n === l.iteration && l.last_exit !== null && l.last_exit !== 0 ? "failed" : "ok", text: tail(readText(join(this.home, "loops", id, `iter-${n}.log`)), 1500), message_id: null });
      out[out.length - 1]!.at = `iteration ${n}`;
    }
    return out;
  }

  // ---------------------------------------------------------------- monitors

  private watchFiles(id: string): { spec: Record<string, any>; state: Record<string, any> } | null {
    const dir = join(this.home, "watches", id);
    const spec = readJson(join(dir, "spec.json"));
    const state = readJson(join(dir, "state.json"));
    return spec === null || state === null ? null : { spec, state };
  }

  private monitorView(id: string): ChatMonitor | null {
    const f = this.watchFiles(id);
    if (f === null || f.spec["target"]?.kind !== "chat") return null;
    const { spec, state } = f;
    const meta = spec["meta"] ?? {};
    const status: ItemStatus = state["status"] === "running" && !this.pidAlive(state["pid"]) ? "lost" : state["status"] === "done" ? "done" : (state["status"] as ItemStatus);
    return {
      id, name: spec["name"] ?? id, spec: meta.spec, interval: Number(spec["interval"] ?? 0), status, reason: state["reason"] ?? null, events: Number(state["events"] ?? 0),
      last_event: state["last_event"] ?? null, once: meta.once === true, debounce: Number(meta.debounce ?? 0), then: meta.then ?? { mode: "tell" },
      expires_at: Number(spec["deadline"] ?? 0), started: spec["started"] ?? "",
    };
  }

  monitorsOf(chatId: string): ChatMonitor[] {
    const ids = dirsIn(join(this.home, "watches")).filter((id) => this.watchFiles(id)?.spec["target"]?.chat_id === chatId);
    const replaced = new Set(ids.map((id) => this.watchFiles(id)?.spec["replaces"]).filter((x): x is string => typeof x === "string"));
    return ids
      .filter((id) => !replaced.has(id))
      .map((id) => this.monitorView(id))
      .filter((m): m is ChatMonitor => m !== null)
      .sort((a, b) => b.started.localeCompare(a.started) || b.id.localeCompare(a.id));
  }

  private monitorOf(chatId: string, id: string): ChatMonitor {
    const m = this.watchFiles(id)?.spec["target"]?.chat_id === chatId ? this.monitorView(id) : null;
    if (m === null) throw new HttpError(404, `unknown monitor: ${id}`);
    return m;
  }

  /** Why this monitor may not be created, or null. Resolves host names so a name that points at a metadata address is refused too. */
  async monitorProblem(spec: MonitorSpec): Promise<string | null> {
    if (spec.target.trim() === "") return "say what to watch";
    if (spec.pattern !== undefined) {
      try {
        new RegExp(spec.pattern);
      } catch {
        return "the pattern is not a valid regular expression";
      }
    }
    if (spec.type === "url") {
      const allow = this.allowLinkLocal();
      const why = urlProblem(spec.target, allow);
      if (why !== null) return why;
      if (!allow) {
        try {
          const host = new URL(spec.target).hostname.replace(/^\[|\]$/g, "");
          for (const a of await lookup(host, { all: true })) {
            if (isLinkLocalIp(a.address)) return "this host resolves to a link-local or metadata address (allow them in settings)";
          }
        } catch {
          // An unresolvable name fails at check time; nothing is fetched here.
        }
      }
    }
    if (spec.type === "git" && spec.condition === "ci" && Bun.which("ghx") === null) return "ghx was not found on this machine, so CI status cannot be read";
    if ((spec.type === "file" || spec.type === "git") && !existsSync(spec.target.replace(/^~(?=\/)/, process.env["HOME"] ?? "~"))) return `${spec.target} does not exist`;
    return null;
  }

  async createMonitor(chatId: string, input: MonitorInput, replaces?: string): Promise<{ id: string }> {
    const chat = this.service.chat(chatId);
    if (chat.archived_at !== null) throw new HttpError(409, "chat is archived");
    const problem = await this.monitorProblem(input.spec);
    if (problem !== null) throw new HttpError(400, problem);
    const target = /^~\//.test(input.spec.target) && (input.spec.type === "file" || input.spec.type === "git") ? input.spec.target.replace(/^~/, process.env["HOME"] ?? "~") : input.spec.target;
    const spec = { ...input.spec, target };
    const c = monitorCommand(spec, this.home);
    const every = c.stream ? 0 : Math.max(minInterval(spec.type), Math.round(input.every ?? (spec.type === "url" || spec.type === "git" ? 60 : 30)));
    const meta = { spec, label: input.name, once: input.once === true, debounce: Math.max(0, input.debounce ?? 0), then: input.then ?? { mode: "tell" }, allow_link_local: this.allowLinkLocal() };
    const args = ["watch", "start", "--name", input.name, "--chat", chatId, "--meta", JSON.stringify(meta), "--max-runtime", `${Math.min(Math.max(60, input.expires_in ?? 86400), 7 * 86400)}s`];
    if (every > 0) args.push("--every", `${every}s`);
    if (c.match) args.push("--match", c.match);
    if (c.baseline) args.push("--baseline");
    if (replaces) args.push("--replaces", replaces);
    args.push(c.cmd);
    return { id: this.ok(await this.run(args)).out.trim() };
  }

  async stopMonitor(chatId: string, id: string): Promise<void> {
    this.monitorOf(chatId, id);
    this.ok(await this.run(["watch", "stop", id]));
  }

  /** The engine has no pause: pausing stops the watch, resuming starts an equal one that replaces it in the list. */
  async resumeMonitor(chatId: string, id: string): Promise<{ id: string }> {
    const m = this.monitorOf(chatId, id);
    if (m.status === "running") return { id };
    return this.createMonitor(chatId, { name: m.name, spec: m.spec, every: m.interval, once: m.once, debounce: m.debounce, then: m.then, expires_in: Math.max(60, m.expires_at - Math.floor(this.now() / 1000)) }, id);
  }

  monitorLog(chatId: string, id: string): LogEntry[] {
    this.monitorOf(chatId, id);
    const lines = readText(join(this.home, "watches", id, "events.jsonl")).split("\n").filter(Boolean).slice(-20).reverse();
    return lines.map((l) => {
      const e = JSON.parse(l) as { ts: string; text: string; kind?: string };
      return { at: e.ts, status: e.kind === "lifecycle" ? "info" : "trigger", text: e.text, message_id: null };
    });
  }

  /** Runs the check once and posts what it saw, without waiting for the interval. */
  async checkNow(chatId: string, id: string): Promise<string> {
    const m = this.monitorOf(chatId, id);
    const c = monitorCommand(m.spec, this.home);
    const proc = Bun.spawn(["sh", "-c", c.stream ? `${c.cmd} | head -n 20` : c.cmd], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), 30_000);
    const text = (await new Response(proc.stdout).text()).trim();
    clearTimeout(timer);
    this.service.postBlock(chatId, { content: `Checked now: ${tail(text, 600) || "(no output)"}`, part: { type: "automation", kind: "monitor", level: "info", title: `Monitor: ${m.name}`, item_id: id } });
    return text;
  }

  // ---------------------------------------------------------------- the bridge: loop and monitor results into chats

  /** One pass: posts new loop iterations, loop ends, monitor triggers and monitor ends into their chats. */
  async poll(): Promise<void> {
    let changed = false;
    for (const id of dirsIn(join(this.home, "loops"))) {
      const l = this.loopFiles(id);
      if (l === null || l.spec["target"]?.kind !== "chat") continue;
      changed = (await this.pollLoop(id, l.spec, l.state)) || changed;
    }
    for (const id of dirsIn(join(this.home, "watches"))) {
      const w = this.watchFiles(id);
      if (w === null || w.spec["target"]?.kind !== "chat") continue;
      changed = (await this.pollWatch(id, w.spec, w.state)) || changed;
    }
    if (changed) this.saveCursors();
  }

  private chatOpen(chatId: string): boolean {
    const chat = this.service.store.getChat(chatId);
    return chat !== null && chat.archived_at === null;
  }

  private async pollLoop(id: string, spec: Record<string, any>, state: Record<string, any>): Promise<boolean> {
    const chatId = String(spec["target"].chat_id);
    const cur = (this.cursors.loops[id] ??= { iter: 0, ended: false });
    if (!this.chatOpen(chatId)) return false;
    let changed = false;
    const label = String(spec["label"] || spec["name"] || id);
    const total = Number(state["iteration"] ?? 0);
    for (let n = cur.iter + 1; n <= total; n++) {
      const text = tail(readText(join(this.home, "loops", id, `iter-${n}.log`)).trim(), POST_MAX);
      const last = n === total;
      const failed = last && typeof state["last_exit"] === "number" && state["last_exit"] !== 0;
      this.service.postBlock(chatId, {
        content: text === "" ? "(no output)" : text,
        part: { type: "automation", kind: "loop", level: failed ? "error" : "result", title: `Loop: ${label}`, item_id: id, counter: `iteration ${n}${Number(spec["max"]) > 0 ? ` of ${spec["max"]}` : ""}`, link: "#/active" },
        failed,
      });
      cur.iter = n;
      changed = true;
    }
    const status = String(state["status"] ?? "");
    if (!cur.ended && (status === "done" || status === "failed" || status === "stopped")) {
      const why: Record<string, string> = { max: "reached its maximum of iterations", until: "its stop condition was met", "max-runtime": "reached its time limit", agent: "the agent ended it", failures: "it failed several times in a row", stopped: "you stopped it" };
      const reason = String(state["reason"] ?? "");
      const failed = status === "failed";
      this.service.postBlock(chatId, {
        content: `Loop ended: ${why[reason] ?? (reason || status)}.`,
        part: { type: "automation", kind: "loop", level: failed ? "error" : "info", title: `Loop: ${label}`, item_id: id, counter: `${total} iterations` },
        failed,
      });
      this.tell(chatId, `Loop ${label} ended: ${why[reason] ?? status}`, id, failed ? "failures" : "schedules");
      cur.ended = true;
      changed = true;
    } else if (changed) {
      this.tell(chatId, `Loop ${label}: iteration ${cur.iter}`, id);
    }
    return changed;
  }

  private async pollWatch(id: string, spec: Record<string, any>, state: Record<string, any>): Promise<boolean> {
    const chatId = String(spec["target"].chat_id);
    const cur = (this.cursors.watches[id] ??= { n: 0, ended: false, lastPost: 0, held: 0, heldText: "" });
    if (!this.chatOpen(chatId)) return false;
    const meta = spec["meta"] ?? {};
    const name = String(spec["name"] ?? id);
    const debounceMs = Number(meta.debounce ?? 0) * 1000;
    const describe = meta.spec ? monitorCommand(meta.spec as MonitorSpec, this.home).describe : name;
    let changed = false;
    for (const line of readText(join(this.home, "watches", id, "events.jsonl")).split("\n").filter(Boolean)) {
      const e = JSON.parse(line) as { n: number; text: string; kind?: string };
      if (e.n <= cur.n) continue;
      cur.n = e.n;
      changed = true;
      if (e.kind === "lifecycle") continue;
      cur.held += 1;
      cur.heldText = e.text;
    }
    const nowMs = this.now();
    if (cur.held > 0 && nowMs - cur.lastPost >= debounceMs) {
      const n = cur.held;
      const text = cur.heldText;
      cur.held = 0;
      cur.heldText = "";
      cur.lastPost = nowMs;
      changed = true;
      await this.trigger(chatId, id, name, describe, text, n, meta);
    }
    const status = String(state["status"] ?? "");
    if (!cur.ended && cur.held === 0 && (status === "done" || status === "stopped" || status === "failed")) {
      cur.ended = true;
      changed = true;
      const reason = String(state["reason"] ?? "");
      const text = reason === "max-runtime" ? "expired" : meta.once === true && cur.lastPost > 0 && reason === "stopped" ? "stopped after its first trigger" : reason === "stopped" ? "stopped" : `ended (${reason || status})`;
      this.service.postBlock(chatId, { content: `Monitor ${text}.`, part: { type: "automation", kind: "monitor", level: "info", title: `Monitor: ${name}`, item_id: id } });
    }
    return changed;
  }

  private async trigger(chatId: string, id: string, name: string, describe: string, text: string, count: number, meta: Record<string, any>): Promise<void> {
    const shown = tail(text.trim(), 800);
    const body = `${describe}${shown === "" ? "" : `: ${shown}`}${count > 1 ? ` (${count} events in the debounce window)` : ""}`;
    this.service.postBlock(chatId, { content: body, part: { type: "automation", kind: "monitor", level: "result", title: `Monitor: ${name}`, item_id: id, link: "#/active" } });
    this.tell(chatId, `${name}: ${body}`, id);
    const then = meta.then as MonitorThen | undefined;
    if (then?.mode === "act" && then.prompt) {
      try {
        this.service.submit(chatId, { content: `Monitor "${name}" triggered.\n\n${then.prompt}\n\nWhat it saw:\n${shown}` });
      } catch (err) {
        this.service.postBlock(chatId, { content: `Could not start the follow-up: ${err instanceof Error ? err.message : String(err)}`, part: { type: "automation", kind: "monitor", level: "error", title: `Monitor: ${name}`, item_id: id }, failed: true });
      }
    }
    if (meta.once === true) {
      await this.run(["watch", "stop", id]);
    }
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(text.length - max)}`;
}

const instances = new WeakMap<ServerContext, ChatAutomation>();

/** One per server, like the chat service. Timers run only in a real server (not under `bun test`). */
export function automationFor(ctx: ServerContext): ChatAutomation {
  let auto = instances.get(ctx);
  if (auto === undefined) {
    const home = ctx.paths.home;
    auto = new ChatAutomation(chatServiceFor(ctx), { home, notify: (category, input) => pushHubFor(home).notify(category, input) });
    instances.set(ctx, auto);
    if (process.env["NODE_ENV"] !== "test" && process.env["ORCH_AUTOMATION_TIMERS"] !== "0") {
      auto.start();
    }
  }
  return auto;
}
