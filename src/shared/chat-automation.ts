/** Schedules, loops and monitors that belong to a chat. Bun-free: used by the CLI, the server and the web. */

export type AutomationMode = "message" | "fresh";
export interface ChatTarget { kind: "chat"; chat_id: string; mode: AutomationMode }

export const LIMITS = {
  maxChatSchedules: 50,
  minScheduleSecs: 300,
  maxChatMonitors: 20,
  minLocalSecs: 10,
  minUrlSecs: 60,
  retryDelaySecs: 300,
  maxFailures: 3,
  graceHoursDefault: 6,
  goalIntervalSecs: 10,
  goalMaxIterations: 20,
} as const;

/** One line for the agent, once per session. It may suggest; the user confirms. No tool creates anything. */
export const AUTOMATION_INSTRUCTION =
  "You may suggest /schedule, /loop or /watch (the user confirms first). /goal runs toward an objective; /feedback records feedback on orch";

/** Label prefix of a loop started by /goal. */
export const GOAL_PREFIX = "Goal: ";

/** The closing line of a goal loop, or null when the loop is not a goal. `agent` means the agent wrote STOP: the goal is met. */
export function goalClosing(label: string, reason: string, iterations: number): string | null {
  if (!label.startsWith(GOAL_PREFIX)) return null;
  if (reason === "agent") return `Goal met after ${iterations} iteration${iterations === 1 ? "" : "s"}.`;
  if (reason === "max") return `Goal not met: stopped at the maximum of ${iterations} iterations.`;
  if (reason === "stopped") return "Goal stopped by you.";
  return `Goal not met: loop ended (${reason || "unknown"}).`;
}

export const SCHEDULED_PREFIX = "Scheduled: ";
export const RESULT_TITLE = "Scheduled result: ";

export interface SchedulePreset { id: string; label: string; cron: string }
export const SCHEDULE_PRESETS: readonly SchedulePreset[] = [
  { id: "daily", label: "Every day at 09:00", cron: "0 9 * * *" },
  { id: "weekdays", label: "Weekdays at 09:00", cron: "0 9 * * 1-5" },
  { id: "sunday", label: "Every Sunday", cron: "0 9 * * 0" },
  { id: "hourly", label: "Every hour", cron: "0 * * * *" },
  { id: "once", label: "Once at a date and time", cron: "" },
  { id: "custom", label: "Custom cron", cron: "" },
];

/** A local `YYYY-MM-DDTHH:MM` (datetime-local value) as a one-shot cron: minute hour day month *. */
export function onceCron(local: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (m === null) {
    return null;
  }
  return `${Number(m[5])} ${Number(m[4])} ${Number(m[3])} ${Number(m[2])} *`;
}

export function presetCron(id: string, opts: { once?: string; custom?: string } = {}): string | null {
  if (id === "once") {
    return onceCron(opts.once ?? "");
  }
  if (id === "custom") {
    return (opts.custom ?? "").trim() || null;
  }
  return SCHEDULE_PRESETS.find((p) => p.id === id)?.cron ?? null;
}

const DAYS: Record<string, number> = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, friday: 5, fri: 5, saturday: 6, sat: 6 };

function clock(h: string | undefined, m: string | undefined, ap: string | undefined): [number, number] | null {
  if (h === undefined) {
    return null;
  }
  let hour = Number(h);
  const min = m === undefined ? 0 : Number(m);
  if (ap !== undefined) {
    hour = (hour % 12) + (ap.toLowerCase() === "pm" ? 12 : 0);
  }
  return hour > 23 || min > 59 ? null : [hour, min];
}

/** The leading "when" of a quick command, as a cron, with the rest of the text. Null when no time phrase starts the text. */
export function parseWhen(text: string): { cron: string; rest: string } | null {
  const t = text.trim();
  const raw = /^((?:\S+\s+){4}\S+)(?:\s+(.*))?$/s.exec(t);
  if (raw !== null && /^[\d*/,\-@a-z]+(\s+[\d*/,\-a-z]+){4}$/i.test(raw[1]!) && /^[\d*/,-]+$/.test(raw[1]!.split(/\s+/)[0]!)) {
    return { cron: raw[1]!, rest: raw[2] ?? "" };
  }
  const at = String.raw`(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?`;
  let m: RegExpExecArray | null;
  if ((m = new RegExp(String.raw`^(?:every\s+hour|hourly)\b\s*(.*)$`, "is").exec(t))) {
    return { cron: "0 * * * *", rest: m[1] ?? "" };
  }
  if ((m = /^every\s+(\d{1,3})\s*(m|min|mins|minutes|h|hours?)\b\s*(.*)$/is.exec(t))) {
    const n = Number(m[1]);
    const hours = m[2]!.toLowerCase().startsWith("h");
    if (n < 1 || (!hours && n > 59) || (hours && n > 23)) {
      return null;
    }
    return { cron: hours ? `0 */${n} * * *` : `*/${n} * * * *`, rest: m[3] ?? "" };
  }
  if ((m = new RegExp(String.raw`^(?:weekdays|every\s+weekday)${at}\b\s*(.*)$`, "is").exec(t))) {
    const c = clock(m[1] ?? "9", m[2], m[3]);
    return c === null ? null : { cron: `${c[1]} ${c[0]} * * 1-5`, rest: m[4] ?? "" };
  }
  if ((m = new RegExp(String.raw`^(?:every\s+day|daily|every\s+morning)${at}\b\s*(.*)$`, "is").exec(t))) {
    const c = clock(m[1] ?? "9", m[2], m[3]);
    return c === null ? null : { cron: `${c[1]} ${c[0]} * * *`, rest: m[4] ?? "" };
  }
  if ((m = new RegExp(String.raw`^every\s+(${Object.keys(DAYS).join("|")})${at}\b\s*(.*)$`, "is").exec(t))) {
    const c = clock(m[2] ?? "9", m[3], m[4]);
    return c === null ? null : { cron: `${c[1]} ${c[0]} * * ${DAYS[m[1]!.toLowerCase()]}`, rest: m[5] ?? "" };
  }
  return null;
}

/** `5m`, `1h`, `30s` to seconds; null when it is not a duration. */
export function durationSecs(text: string): number | null {
  const m = /^(\d+)\s*([smhd]?)$/i.exec(text.trim());
  if (m === null) {
    return null;
  }
  return Number(m[1]) * ({ "": 1, s: 1, m: 60, h: 3600, d: 86400 } as Record<string, number>)[m[2]!.toLowerCase()]!;
}

export type SlashCommand =
  | { cmd: "schedules" | "loops" | "monitors" }
  | { cmd: "schedule"; cron: string; prompt: string }
  | { cmd: "loop"; every: string; prompt: string }
  | { cmd: "watch"; what: string }
  | { cmd: "goal"; objective: string }
  | { cmd: "goal-stop" | "goal-show" }
  | { cmd: "feedback-add"; text: string }
  | { cmd: "feedback-list" | "feedback-work" }
  | { cmd: "error"; message: string };

/** A composer line that starts with one of the automation commands, or null for ordinary text. */
export function parseSlash(text: string): SlashCommand | null {
  const m = /^\/(schedules|schedule|loops|loop|monitors|watch|goal|feedback)\b\s*(.*)$/is.exec(text.trim());
  if (m === null) {
    return null;
  }
  const name = m[1]!.toLowerCase();
  const rest = (m[2] ?? "").trim();
  if (name === "schedules" || name === "loops" || name === "monitors") {
    return { cmd: name };
  }
  if (name === "goal") {
    if (rest === "") return { cmd: "goal-show" };
    if (rest.toLowerCase() === "stop") return { cmd: "goal-stop" };
    return { cmd: "goal", objective: rest };
  }
  if (name === "feedback") {
    if (rest === "") return { cmd: "error", message: "Say the feedback, or use /feedback list or /feedback work" };
    if (rest.toLowerCase() === "list") return { cmd: "feedback-list" };
    if (rest.toLowerCase() === "work") return { cmd: "feedback-work" };
    return { cmd: "feedback-add", text: rest };
  }
  if (name === "schedule") {
    const w = parseWhen(rest);
    if (w === null) {
      return { cmd: "error", message: "Say when first, for example /schedule every day at 09:00 summarise the news" };
    }
    return w.rest.trim() === "" ? { cmd: "error", message: "Add what to run after the time" } : { cmd: "schedule", cron: w.cron, prompt: w.rest.trim() };
  }
  if (name === "loop") {
    const m2 = /^(?:every\s+)?(\d+\s*[smhd])\s+(.+)$/is.exec(rest);
    const secs = m2 === null ? null : durationSecs(m2[1]!);
    if (m2 === null || secs === null || secs < LIMITS.minLocalSecs) {
      return { cmd: "error", message: "Use /loop 10m <prompt> (at least 10s)" };
    }
    return { cmd: "loop", every: m2[1]!.replace(/\s+/g, ""), prompt: m2[2]!.trim() };
  }
  return rest === "" ? { cmd: "error", message: "Say what to watch: /watch <url|path|command>" } : { cmd: "watch", what: rest };
}

export type MonitorType = "file" | "url" | "command" | "stream" | "run" | "git";

export interface MonitorSpec {
  type: MonitorType;
  /** file/folder path, url, command, run id or repo folder, by type. */
  target: string;
  /** url: `status` or `text` change. command: `exit` or `regex`. git: `commits` or `ci`. */
  condition?: string;
  /** Regex for `command` with condition regex, or for run (default finished|failed|stalled). */
  pattern?: string;
}

/** The monitor kind a `/watch` argument most likely means. */
export function guessMonitor(what: string): MonitorSpec {
  const w = what.trim();
  if (/^https?:\/\//i.test(w)) {
    return { type: "url", target: w, condition: "status" };
  }
  if (/^(~|\/|\.\.?\/)/.test(w) && !/\s/.test(w)) {
    return { type: "file", target: w };
  }
  return { type: "command", target: w, condition: "exit" };
}

const BLOCKED_HOSTS = new Set(["metadata.google.internal", "metadata", "instance-data"]);

export function isLinkLocalIp(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (/^169\.254\./.test(v) || /^fe[89ab][0-9a-f]:/.test(v) || v === "100.100.100.200" || v === "fd00:ec2::254") {
    return true;
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped !== null) {
    return isLinkLocalIp(mapped[1]!);
  }
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v);
  if (hex !== null) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    return isLinkLocalIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return false;
}

/** Null when the URL may be watched, else the reason. Hosts are also resolved on the server (see `urlBlockedAfterDns`). */
export function urlProblem(raw: string, allowLinkLocal = false): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "not a valid URL";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return "only http and https URLs can be watched";
  }
  if (u.username !== "" || u.password !== "") {
    return "a URL with a user name or password is not allowed";
  }
  if (!allowLinkLocal && (BLOCKED_HOSTS.has(u.hostname.toLowerCase()) || isLinkLocalIp(u.hostname))) {
    return "link-local and metadata addresses are blocked (allow them in settings)";
  }
  return null;
}
