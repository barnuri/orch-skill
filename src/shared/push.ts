// Shared by the server, the page and the service workers: must stay Bun-free and DOM-free.
export const PUSH_CATEGORIES = ["replies", "questions", "failures", "runs", "schedules"] as const;
export type PushCategory = (typeof PUSH_CATEGORIES)[number];

export const PUSH_CATEGORY_LABELS: Readonly<Record<PushCategory, string>> = {
  replies: "Replies",
  questions: "Questions",
  failures: "Failures",
  runs: "Orch runs",
  schedules: "Schedules",
};

export interface QuietHours {
  enabled: boolean;
  /** Minutes after local midnight. */
  start: number;
  end: number;
  /** `Date.getTimezoneOffset()` of the device that saved it (minutes, UTC minus local). */
  tz_offset: number;
}

export const DEFAULT_QUIET_HOURS: QuietHours = { enabled: false, start: 22 * 60, end: 7 * 60, tz_offset: 0 };

/** The `data` of a notification and what the service worker needs to open it. */
export interface PushData {
  url: string;
  tag: string;
  category: PushCategory;
  chat_id?: string;
  run_id?: string;
}

export interface PushMessage {
  title: string;
  body: string;
  tag: string;
  url: string;
  category: PushCategory;
  badge: number | null;
  icon: "chat" | "dashboard";
  actions: { action: string; title: string }[];
  data: PushData;
}

/** Chat links stay inside the installed chat app's scope (`/chat/`). */
export const chatUrl = (chatId: string): string => `/chat/#/chats/${encodeURIComponent(chatId)}`;
export const runUrl = (runId: string): string => `/#/run/${encodeURIComponent(runId)}`;
export const schedulesUrl = (): string => "/#/schedules";

/** Only same-origin paths may be opened by a notification click. */
export function safeClickUrl(raw: unknown, origin: string): string {
  if (typeof raw !== "string" || raw === "") return "/";
  try {
    const u = new URL(raw, origin);
    return u.origin === origin ? `${u.pathname}${u.search}${u.hash}` : "/";
  } catch {
    return "/";
  }
}

/** True when `now` (epoch ms) falls inside the quiet window, in the device's local time. A window may wrap midnight. */
export function inQuietHours(q: QuietHours, nowMs: number): boolean {
  if (!q.enabled || q.start === q.end) return false;
  const local = new Date(nowMs - q.tz_offset * 60_000);
  const m = local.getUTCHours() * 60 + local.getUTCMinutes();
  return q.start < q.end ? m >= q.start && m < q.end : m >= q.start || m < q.end;
}

export const CATEGORY_URGENCY: Readonly<Record<PushCategory, "very-low" | "low" | "normal" | "high">> = {
  replies: "normal",
  questions: "high",
  failures: "high",
  runs: "low",
  schedules: "low",
};

export const CATEGORY_TTL_S: Readonly<Record<PushCategory, number>> = {
  replies: 60 * 60,
  questions: 6 * 60 * 60,
  failures: 6 * 60 * 60,
  runs: 60 * 60,
  schedules: 30 * 60,
};

/** First `max` characters of a reply as one line; markdown fences and tool output never reach a notification. */
export function notificationBody(text: string, max = 140): string {
  const flat = text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/[#*_`>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

const SECRET = /(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._-]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+|(?:token|password|secret|api[_-]?key)\s*[=:]\s*\S+)/gi;
export const redactSecrets = (text: string): string => text.replace(SECRET, "[hidden]");
