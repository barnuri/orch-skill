import { type AutomationMode, LIMITS, type MonitorSpec, type MonitorType, SCHEDULE_PRESETS, durationSecs, presetCron, urlProblem } from "../../shared/chat-automation";
import { machineZone, nextRuns, validZone } from "../../shared/cron-next";
import type { ChatLoop, ChatMonitor, ItemStatus, LoopInput, MonitorInput, ScheduleCreate } from "../../shared/types/chat-automation";
import type { Schedule } from "../../shared/types/schedule";
import { describeCron } from "../lib/cron-text";
import { everyLabel, truncate } from "../lib/format";

export type Tab = "schedules" | "loops" | "monitors";
export type Tone = "ok" | "error" | "running" | "paused" | "idle";

export const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "schedules", label: "Schedules" },
  { id: "loops", label: "Loops" },
  { id: "monitors", label: "Monitors" },
];

export const EMPTY_TEXT: Readonly<Record<Tab, string>> = {
  schedules: "No schedules yet. Use the clock button next to the message box, or type /schedule every day at 09:00 <prompt>.",
  loops: "No loops yet. Press New, or type /loop 10m <prompt> to repeat a prompt.",
  monitors: "No monitors yet. Press New, or type /watch <url, path or command> to be told when it changes.",
};

export function scheduleTone(s: Schedule): Tone {
  if (!s.enabled) return "paused";
  if (s.last_status === "failed" || s.last_status === "lost") return "error";
  return s.last_status === "running" ? "running" : "ok";
}

export function itemTone(status: ItemStatus): Tone {
  if (status === "running") return "running";
  if (status === "failed" || status === "lost") return "error";
  return status === "done" ? "ok" : "paused";
}

export function cronSummary(cron: string, tz?: string): string {
  const text = describeCron(cron);
  const base = text === null ? cron : text.ok ? text.text : cron;
  return tz === undefined || tz === "" ? base : `${base} (${tz})`;
}

export function scheduleSummary(s: Schedule): string {
  return `${s.target?.mode === "fresh" ? "Fresh session" : "Continues this chat"} · ${cronSummary(s.cron, s.timezone)}`;
}

export function lastResult(s: Schedule): { label: string; tone: Tone } {
  const run = s.runs[0];
  if (run === undefined) return { label: "Never ran", tone: "idle" };
  const tone: Tone = run.status === "ok" ? "ok" : run.status === "failed" || run.status === "lost" ? "error" : run.status === "running" ? "running" : "paused";
  const label = run.status === "ok" ? "Ran" : run.status === "skipped" ? "Skipped a missed run" : run.status === "failed" ? `Failed${run.error ? `: ${truncate(run.error, 60)}` : ""}` : run.status;
  return { label, tone };
}

export function loopSummary(l: ChatLoop): string {
  const every = l.interval <= 10 ? "when the last one is done" : `every ${everyLabel(l.interval)}`;
  const stop: string[] = [];
  if (l.max > 0) stop.push(`up to ${l.max}`);
  if (l.until.text !== "") stop.push(`until ${truncate(l.until.text, 40)}`);
  if (l.until.regex !== "") stop.push(`until /${truncate(l.until.regex, 30)}/`);
  if (l.until.command !== "") stop.push("until a command succeeds");
  return `${l.mode === "fresh" ? "Fresh result each time" : "Continues this chat"} · ${every}${stop.length > 0 ? ` · ${stop.join(", ")}` : ""}`;
}

export function loopProgress(l: ChatLoop): string {
  const n = `iteration ${l.iteration}${l.max > 0 ? ` of ${l.max}` : ""}`;
  const why: Record<string, string> = { max: "reached its maximum", until: "stop condition met", "max-runtime": "time limit", agent: "ended by the agent", failures: "failed 3 times in a row", stopped: "stopped" };
  return l.status === "running" ? n : `${n} · ${why[l.reason ?? ""] ?? l.status}`;
}

export const MONITOR_TYPES: ReadonlyArray<{ id: MonitorType; label: string; target: string; hint: string }> = [
  { id: "file", label: "File or folder", target: "Path", hint: "Tell me when it changes." },
  { id: "url", label: "URL", target: "https://…", hint: "Checked at most once a minute. Only http and https." },
  { id: "command", label: "Command", target: "Command", hint: "Checked every few seconds; tell me when the exit code changes or the output matches." },
  { id: "stream", label: "Command output", target: "Long-running command", hint: "Runs the command and tells me about lines that match." },
  { id: "run", label: "Orch run", target: "Run id", hint: "Tell me when it finishes, fails or stalls." },
  { id: "git", label: "Git repo", target: "Folder of the repo", hint: "New commits, or CI status when ghx is installed." },
];

export function monitorSummary(m: ChatMonitor): string {
  const t = m.spec;
  const what: Record<string, string> = {
    file: `${t.target} changes`,
    url: t.condition === "text" ? `${t.target} text changes` : `${t.target} status changes`,
    command: t.condition === "regex" ? `output of ${truncate(t.target, 40)} matches /${t.pattern ?? ""}/` : `exit code of ${truncate(t.target, 40)} changes`,
    stream: `${truncate(t.target, 40)} prints${t.pattern ? ` /${t.pattern}/` : ""}`,
    run: `run ${t.target} finishes, fails or stalls`,
    git: t.condition === "ci" ? `CI of ${t.target} changes` : `new commits in ${t.target}`,
  };
  const bits = [what[t.type] ?? t.target, m.interval > 0 ? `every ${everyLabel(m.interval)}` : "live", m.once ? "once" : "every time", m.then.mode === "act" ? "then acts" : "then tells me"];
  return bits.join(" · ");
}

export function monitorExpiry(m: ChatMonitor): string {
  return m.expires_at > 0 ? new Date(m.expires_at * 1000).toLocaleString() : "no expiry";
}

// ---- schedule form

export interface ScheduleDraft {
  name: string;
  prompt: string;
  preset: string;
  once: string;
  custom: string;
  mode: AutomationMode;
  timezone: string;
}

export function emptyScheduleDraft(prompt = ""): ScheduleDraft {
  return { name: nameFrom(prompt), prompt, preset: "daily", once: "", custom: "", mode: "message", timezone: machineZone() };
}

export function nameFrom(prompt: string): string {
  const line = prompt.trim().split("\n")[0] ?? "";
  return truncate(line.replace(/^Scheduled:\s*/, ""), 40);
}

export function draftCron(d: ScheduleDraft): string | null {
  return presetCron(d.preset, { once: d.once, custom: d.custom });
}

export interface Preview { text: string; runs: string[]; error: string | null }

export function previewOf(d: ScheduleDraft, nowSecs: number): Preview {
  const cron = draftCron(d);
  if (cron === null) return { text: "", runs: [] as string[], error: d.preset === "once" ? "Pick a date and time." : d.preset === "custom" ? "Type a cron expression, e.g. 0 9 * * 1-5." : null };
  const text = describeCron(cron);
  if (text !== null && !text.ok) return { text: "", runs: [], error: text.error };
  const tz = validZone(d.timezone) ? d.timezone : machineZone();
  const runs = nextRuns(cron, nowSecs, 3, tz);
  if (runs.length === 0) return { text: text?.ok ? text.text : cron, runs: [], error: "This never runs." };
  if (runs.length > 1 && runs[1]! - runs[0]! < LIMITS.minScheduleSecs) return { text: text?.ok ? text.text : cron, runs: [], error: `At least ${LIMITS.minScheduleSecs / 60} minutes between runs.` };
  const fmt = new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return { text: text?.ok ? text.text : cron, runs: runs.map((r) => fmt.format(new Date(r * 1000))), error: null };
}

export function scheduleBody(d: ScheduleDraft): { body: ScheduleCreate | null; errors: Partial<Record<"name" | "prompt" | "when" | "timezone", string>> } {
  const errors: Partial<Record<"name" | "prompt" | "when" | "timezone", string>> = {};
  if (d.prompt.trim() === "") errors.prompt = "Say what to run.";
  if (d.name.trim() === "") errors.name = "Give it a name.";
  if (!validZone(d.timezone)) errors.timezone = "Unknown time zone.";
  const cron = draftCron(d);
  const p = previewOf(d, Math.floor(Date.now() / 1000));
  if (cron === null || p.error !== null) errors.when = p.error ?? "Choose when.";
  if (Object.keys(errors).length > 0 || cron === null) return { body: null, errors };
  return { body: { name: d.name.trim(), prompt: d.prompt.trim(), cron, timezone: d.timezone, mode: d.mode, ...(d.preset === "once" ? { once: true } : {}) }, errors };
}

export function draftOfSchedule(s: Schedule): ScheduleDraft {
  const preset = SCHEDULE_PRESETS.find((p) => p.cron !== "" && p.cron === s.cron);
  return { name: s.name, prompt: s.prompt ?? "", preset: preset?.id ?? "custom", once: "", custom: preset === undefined ? s.cron : "", mode: s.target?.mode ?? "message", timezone: s.timezone ?? machineZone() };
}

// ---- loop form

export interface LoopDraft {
  label: string;
  prompt: string;
  cadence: "interval" | "done";
  minutes: string;
  max: string;
  stopKind: "none" | "text" | "regex" | "command";
  stop: string;
  mode: AutomationMode;
}

export const emptyLoopDraft = (prompt = ""): LoopDraft => ({ label: nameFrom(prompt), prompt, cadence: "interval", minutes: "10", max: "10", stopKind: "none", stop: "", mode: "message" });

export function loopBody(d: LoopDraft): { body: LoopInput | null; errors: Partial<Record<"label" | "prompt" | "minutes" | "max" | "stop", string>> } {
  const errors: Partial<Record<"label" | "prompt" | "minutes" | "max" | "stop", string>> = {};
  if (d.prompt.trim() === "") errors.prompt = "Say what to repeat.";
  if (d.label.trim() === "") errors.label = "Give it a name.";
  const mins = Number(d.minutes);
  if (d.cadence === "interval" && !(mins >= 1 / 6 && mins <= 7 * 24 * 60)) errors.minutes = "At least 10 seconds (0.2 minutes).";
  if (d.max.trim() !== "" && !/^\d+$/.test(d.max.trim())) errors.max = "A whole number, or empty for no limit.";
  if (d.stopKind !== "none" && d.stop.trim() === "") errors.stop = "Say when to stop.";
  if (d.stopKind === "regex") {
    try {
      new RegExp(d.stop);
    } catch {
      errors.stop = "Not a valid regular expression.";
    }
  }
  if (Object.keys(errors).length > 0) return { body: null, errors };
  const body: LoopInput = {
    label: d.label.trim(), prompt: d.prompt.trim(), every: d.cadence === "done" ? 10 : Math.max(10, Math.round(mins * 60)), mode: d.mode,
    ...(d.max.trim() !== "" && Number(d.max) > 0 ? { max: Number(d.max) } : {}),
    ...(d.stopKind === "text" ? { until_text: d.stop.trim() } : d.stopKind === "regex" ? { until_regex: d.stop } : d.stopKind === "command" ? { until_command: d.stop.trim() } : {}),
  };
  return { body, errors };
}

// ---- monitor form

export interface MonitorDraft {
  name: string;
  type: MonitorType;
  target: string;
  condition: string;
  pattern: string;
  every: string;
  repeat: "once" | "repeat";
  debounce: string;
  expiry: string;
  then: "tell" | "act";
  thenPrompt: string;
}

export const emptyMonitorDraft = (target = "", type: MonitorType = "file"): MonitorDraft => ({
  name: target === "" ? "" : truncate(target, 40), type, target, condition: type === "url" ? "status" : type === "command" ? "exit" : type === "git" ? "commits" : "", pattern: "",
  every: type === "url" || type === "git" ? "60" : "30", repeat: "repeat", debounce: "0", expiry: "24h", then: "tell", thenPrompt: "",
});

export function monitorBody(d: MonitorDraft, allowLinkLocal = false): { body: MonitorInput | null; errors: Partial<Record<"name" | "target" | "pattern" | "every" | "expiry" | "thenPrompt", string>> } {
  const errors: Partial<Record<"name" | "target" | "pattern" | "every" | "expiry" | "thenPrompt", string>> = {};
  if (d.name.trim() === "") errors.name = "Give it a name.";
  if (d.target.trim() === "") errors.target = "Say what to watch.";
  else if (d.type === "url") {
    const why = urlProblem(d.target.trim(), allowLinkLocal);
    if (why !== null) errors.target = why;
  }
  const needsPattern = (d.type === "command" && d.condition === "regex") || d.type === "stream";
  if (d.pattern !== "") {
    try {
      new RegExp(d.pattern);
    } catch {
      errors.pattern = "Not a valid regular expression.";
    }
  } else if (d.type === "command" && d.condition === "regex") errors.pattern = "Type the pattern to look for.";
  void needsPattern;
  const min = d.type === "url" ? LIMITS.minUrlSecs : LIMITS.minLocalSecs;
  const every = durationSecs(/^\d+$/.test(d.every.trim()) ? `${d.every.trim()}s` : d.every);
  if (d.type !== "stream" && (every === null || every < min)) errors.every = `At least ${min} seconds.`;
  const expiry = durationSecs(d.expiry);
  if (expiry === null || expiry < 60 || expiry > 7 * 86400) errors.expiry = "Between 1m and 7d, e.g. 24h.";
  if (d.then === "act" && d.thenPrompt.trim() === "") errors.thenPrompt = "Say what the agent should do.";
  if (Object.keys(errors).length > 0) return { body: null, errors };
  const spec: MonitorSpec = { type: d.type, target: d.target.trim(), ...(d.condition !== "" ? { condition: d.condition } : {}), ...(d.pattern !== "" ? { pattern: d.pattern } : {}) };
  return {
    body: {
      name: d.name.trim(), spec, every: d.type === "stream" ? undefined : (every as number), once: d.repeat === "once", debounce: Math.max(0, Number(d.debounce) || 0), expires_in: expiry as number,
      then: d.then === "act" ? { mode: "act", prompt: d.thenPrompt.trim() } : { mode: "tell" },
    },
    errors,
  };
}

/** How many items are alive in each tab, for the badge on the header button. */
export function activeCounts(s: readonly Schedule[], l: readonly ChatLoop[], m: readonly ChatMonitor[]): { schedules: number; loops: number; monitors: number; total: number; live: boolean } {
  const schedules = s.filter((x) => x.enabled).length;
  const loops = l.filter((x) => x.status === "running").length;
  const monitors = m.filter((x) => x.status === "running").length;
  return { schedules, loops, monitors, total: schedules + loops + monitors, live: loops + monitors > 0 };
}
