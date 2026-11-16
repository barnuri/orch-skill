import type { Attachment, ChatOptions, HarnessOption, Message, ModelOption, ProfileOption } from "./chat-types";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_MESSAGE_BYTES = 100 * 1024 * 1024;
export const MAX_ATTACHMENTS = 20;

// ---- message ordering and live events ----

/**
 * Display position. The assistant row is created before the tool rows of its reply, so its id sorts
 * too early: it goes where its reply ended (still streaming: last). Everything else goes by creation time.
 */
function sortKey(m: Message): string {
  const at = m.role === "assistant" ? (m.finished_at ?? "9999") : m.created_at;
  return `${at}|${m.id}`;
}

export function sortMessages(messages: readonly Message[]): Message[] {
  return [...messages].sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** Insert or replace by id; never lets a stale row shorten a message that deltas already grew. */
export function upsertMessage(list: readonly Message[], next: Message): Message[] {
  const index = list.findIndex((m) => m.id === next.id);
  if (index < 0) {
    return sortMessages([...list, next]);
  }
  const current = list[index] as Message;
  const keepLonger = current.status === "streaming" && next.status === "streaming" && current.content.length > next.content.length;
  const merged = keepLonger ? { ...next, content: current.content } : next;
  const out = [...list];
  out[index] = merged;
  return out;
}

/** Older pages (newest first from the API) merged under what is already shown. */
export function prependOlder(list: readonly Message[], olderNewestFirst: readonly Message[]): Message[] {
  const known = new Set(list.map((m) => m.id));
  return sortMessages([...olderNewestFirst.filter((m) => !known.has(m.id)), ...list]);
}

export interface ChatEventData {
  event: string;
  data: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** Applies one SSE event to the message list. Unknown or malformed events change nothing. */
export function applyChatEvent(list: readonly Message[], ev: ChatEventData, nowIso: string): Message[] {
  const data = record(ev.data);
  if (data === null) {
    return [...list];
  }
  if (ev.event === "message") {
    const message = record(data["message"]);
    return message === null ? [...list] : upsertMessage(list, message as unknown as Message);
  }
  const id = typeof data["message_id"] === "string" ? data["message_id"] : null;
  const index = id === null ? -1 : list.findIndex((m) => m.id === id);
  if (index < 0) {
    return [...list];
  }
  const current = list[index] as Message;
  let next: Message = current;
  if (ev.event === "activity") {
    next = current.status === "streaming" || current.status === "pending" ? { ...current, activity: data as unknown as Message["activity"] } : current;
  } else if (ev.event === "delta" && typeof data["text"] === "string" && typeof data["offset"] === "number") {
    const text = data["text"];
    const start = data["offset"] - text.length;
    if (start <= current.content.length && data["offset"] > current.content.length) {
      next = { ...current, content: current.content.slice(0, Math.max(0, start)) + text, status: "streaming" };
    }
  } else if (ev.event === "usage") {
    next = {
      ...current,
      input_tokens: Number(data["input_tokens"] ?? current.input_tokens),
      output_tokens: Number(data["output_tokens"] ?? current.output_tokens),
      cost_usd: typeof data["cost_usd"] === "number" ? data["cost_usd"] : current.cost_usd,
      model_used: typeof data["model"] === "string" ? data["model"] : current.model_used,
    };
  } else if (ev.event === "done") {
    const status = data["status"];
    next = {
      ...current,
      status: status === "error" || status === "stopped" ? status : "done",
      activity: null,
      error: typeof data["error"] === "string" ? data["error"] : null,
      finished_at: current.finished_at ?? nowIso,
      context_truncated: data["context_truncated"] === true || data["context_truncated"] === 1,
      warning: typeof data["warning"] === "string" ? data["warning"] : null,
    };
  }
  const out = [...list];
  out[index] = next;
  return out;
}

/** The id the server wants in Last-Event-ID: the oldest reply still streaming (so its missed text replays), else the newest row. */
export function resumeId(list: readonly Message[]): string | null {
  const open = list.find((m) => m.status === "streaming" || m.status === "pending");
  const anchor = open ?? list[list.length - 1];
  return anchor === undefined ? null : `${anchor.id}.${anchor.content.length}`;
}

export function isLive(message: Message): boolean {
  return message.status === "streaming" || message.status === "pending";
}

/** Last assistant row that failed or stopped, and the user text before it, for Retry. */
export function retryTarget(list: readonly Message[]): { assistant: Message; text: string } | null {
  const last = [...list].reverse().find((m) => m.role === "assistant" || m.role === "user");
  if (last === undefined || last.role !== "assistant" || last.status !== "error") {
    return null;
  }
  const user = [...list].reverse().find((m) => m.role === "user" && m.id < last.id);
  return user === undefined ? null : { assistant: last, text: user.content };
}

export function messageDurationMs(message: Message, now: number): number | null {
  if (message.started_at === null) {
    return null;
  }
  const start = Date.parse(message.started_at);
  const end = message.finished_at !== null ? Date.parse(message.finished_at) : isLive(message) ? now : NaN;
  return Number.isNaN(start) || Number.isNaN(end) ? null : Math.max(0, end - start);
}

// ---- pickers ----

export interface Selection {
  harness: string;
  profile: string;
  model: string | null;
}

export interface PickerState<T> {
  options: T[];
  value: string;
  /** True when the user cannot change it: one choice, or none. */
  locked: boolean;
  /** Why a locked or empty picker is stuck. */
  reason: string | null;
}

export function harnessUsable(h: HarnessOption): boolean {
  return h.enabled && h.available;
}

export function harnessProblem(h: HarnessOption): string | null {
  return !h.enabled ? "disabled in settings" : !h.available ? "not installed on this machine" : null;
}

export function profileUsable(p: ProfileOption): boolean {
  return p.enabled && p.configured;
}

export function profileProblem(p: ProfileOption): string | null {
  return !p.enabled ? "disabled" : !p.configured ? (p.problem ?? "not configured") : null;
}

function findHarness(options: ChatOptions, id: string): HarnessOption | undefined {
  return options.harnesses.find((h) => h.id === id);
}

function defaultModel(models: readonly ModelOption[]): string | null {
  const preferred = models.find((m) => m.default) ?? models[0];
  return preferred === undefined ? null : preferred.id;
}

/** Repairs a selection so each level exists and is usable, falling back down the cascade. */
export function normalizeSelection(options: ChatOptions, wanted: Selection | null): Selection {
  const usable = options.harnesses.filter(harnessUsable);
  const fallbackHarness =
    usable.find((h) => h.id === options.default_harness) ?? usable[0] ?? options.harnesses[0];
  const harness = (wanted !== null ? findHarness(options, wanted.harness) : undefined) ?? fallbackHarness;
  // A chat's own harness stays selected even when it is disabled: the picker shows it greyed so it can be switched away from.
  const harnessPick = harness ?? fallbackHarness;
  if (harnessPick === undefined) {
    return { harness: "", profile: "", model: null };
  }
  const profiles = harnessPick.profiles;
  const okProfiles = profiles.filter(profileUsable);
  const profile =
    profiles.find((p) => p.name === wanted?.profile && profileUsable(p)) ??
    okProfiles.find((p) => p.name === options.default_profile) ??
    okProfiles[0] ??
    profiles.find((p) => p.name === wanted?.profile) ??
    profiles[0];
  if (profile === undefined) {
    return { harness: harnessPick.id, profile: "", model: null };
  }
  const model = profile.models.find((m) => m.id === wanted?.model)?.id ?? defaultModel(profile.models);
  return { harness: harnessPick.id, profile: profile.name, model };
}

export interface Pickers {
  selection: Selection;
  harness: PickerState<HarnessOption>;
  profile: PickerState<ProfileOption>;
  model: PickerState<ModelOption>;
  persistent: boolean | null;
  /** A chat can start only when harness, profile and model are all usable. */
  canStart: boolean;
  problem: string | null;
}

export function resolvePickers(options: ChatOptions, wanted: Selection | null): Pickers {
  const selection = normalizeSelection(options, wanted);
  const harness = findHarness(options, selection.harness);
  const profiles = harness?.profiles ?? [];
  const profile = profiles.find((p) => p.name === selection.profile);
  const models = profile?.models ?? [];
  const usableHarnesses = options.harnesses.filter(harnessUsable);
  const usableProfiles = profiles.filter(profileUsable);

  const harnessState: PickerState<HarnessOption> = {
    options: options.harnesses,
    value: selection.harness,
    locked: usableHarnesses.length <= 1 && (harness === undefined || harnessUsable(harness)),
    reason: usableHarnesses.length === 0 ? "no harness is enabled and installed: enable one on the Harnesses page" : null,
  };
  const profileState: PickerState<ProfileOption> = {
    options: profiles,
    value: selection.profile,
    locked: usableProfiles.length <= 1,
    reason: harness === undefined ? "pick a harness first" : usableProfiles.length === 0 ? (profiles[0] !== undefined ? profileProblem(profiles[0]) : "no profile on this harness") : null,
  };
  const modelState: PickerState<ModelOption> = {
    options: models,
    value: selection.model ?? "",
    locked: models.length <= 1,
    reason: profile === undefined ? "pick a profile first" : models.length === 0 ? "the profile lists no models" : null,
  };
  const alternative = usableHarnesses.find((h) => h.id !== harness?.id);
  const problem =
    harnessState.reason ??
    (harness !== undefined && !harnessUsable(harness)
      ? `${harness.label} is ${harnessProblem(harness) ?? "unavailable"}${alternative === undefined ? "" : `: pick ${alternative.label} above to send`}`
      : null) ??
    profileState.reason ??
    (profile !== undefined && !profileUsable(profile) ? profileProblem(profile) : null);
  return {
    selection,
    harness: harnessState,
    profile: profileState,
    model: modelState,
    persistent: harness?.persistent ?? null,
    canStart: problem === null && selection.harness !== "" && selection.profile !== "",
    problem,
  };
}

/** The label for the model a chat is configured with. */
export function modelLabel(options: ChatOptions | undefined, sel: Selection): string {
  const profile = options?.harnesses.find((h) => h.id === sel.harness)?.profiles.find((p) => p.name === sel.profile);
  const model = profile?.models.find((m) => m.id === sel.model) ?? profile?.models.find((m) => m.default);
  return model?.label ?? sel.model ?? "default model";
}

// ---- attachments ----

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isImageMime(mime: string): boolean {
  return /^image\/(png|jpe?g|webp|gif)$/.test(mime);
}

export interface FileLike {
  name: string;
  size: number;
  type: string;
}

/** Error text for a file the backend would refuse; null when it fits. `taken` is bytes already queued for this message. */
export function validateFile(file: FileLike, taken: number, count: number): string | null {
  if (file.size === 0) {
    return `${file.name} is empty`;
  }
  if (file.size > MAX_FILE_BYTES) {
    return `${file.name} is ${formatBytes(file.size)}; the limit is 25 MB per file`;
  }
  if (taken + file.size > MAX_MESSAGE_BYTES) {
    return `${file.name} would take this message past 100 MB`;
  }
  if (count >= MAX_ATTACHMENTS) {
    return `a message holds at most ${MAX_ATTACHMENTS} files`;
  }
  return null;
}

const GENERIC_IMAGE_NAME = /^(image|unnamed|blob)(\.[a-z0-9]+)?$/i;

/** Pasted bitmaps arrive as "image.png" or nameless; give them a time-stamped name. */
export function pastedName(file: File, now: number): File {
  if (!file.type.startsWith("image/") || !(file.name === "" || GENERIC_IMAGE_NAME.test(file.name))) {
    return file;
  }
  const ext = file.type === "image/jpeg" ? "jpg" : (file.type.split("/")[1] ?? "png").replace(/[^a-z0-9]/gi, "");
  return new File([file], `pasted-${now}.${ext}`, { type: file.type, lastModified: now });
}

interface ClipboardLike {
  files?: ArrayLike<File> | null;
  items?: ArrayLike<{ kind: string; getAsFile: () => File | null }> | null;
}

/** Files on the clipboard (images, files copied in Finder), named; empty when the paste is plain text. */
export function filesFromClipboard(data: ClipboardLike | null | undefined, now: number): File[] {
  if (data === null || data === undefined) {
    return [];
  }
  let files = Array.from(data.files ?? []);
  if (files.length === 0 && data.items !== null && data.items !== undefined) {
    files = Array.from(data.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
  }
  return files.map((f, i) => pastedName(f, now + i));
}

// ---- drafts ----

export interface Draft {
  text: string;
  attachments: Attachment[];
}

export const DRAFT_PREFIX = "orch.chat.draft.";

export function loadDraft(storage: Pick<Storage, "getItem">, chatId: string): Draft {
  try {
    const raw = storage.getItem(DRAFT_PREFIX + chatId);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    const rec = record(parsed);
    if (rec === null) {
      return { text: "", attachments: [] };
    }
    return {
      text: typeof rec["text"] === "string" ? rec["text"] : "",
      attachments: Array.isArray(rec["attachments"]) ? (rec["attachments"] as Attachment[]).filter((a) => typeof a.id === "string") : [],
    };
  } catch {
    return { text: "", attachments: [] };
  }
}

export function saveDraft(storage: Pick<Storage, "setItem" | "removeItem">, chatId: string, draft: Draft): void {
  try {
    if (draft.text === "" && draft.attachments.length === 0) {
      storage.removeItem(DRAFT_PREFIX + chatId);
    } else {
      storage.setItem(DRAFT_PREFIX + chatId, JSON.stringify(draft));
    }
  } catch {
    // storage full or blocked: the draft is only a convenience
  }
}

// ---- display ----

export function formatTokens(input: number, output: number): string | null {
  return input === 0 && output === 0 ? null : `${input.toLocaleString("en-US")} in / ${output.toLocaleString("en-US")} out`;
}

// ---- thread list and keyboard ----

/** A chat nobody wrote in is hidden once you leave it; the open one always stays. Archived lists show everything. */
export function visibleChats<T extends { id: string; empty?: boolean | undefined }>(chats: readonly T[], activeChatId: string | null, archived: boolean): T[] {
  return archived ? [...chats] : chats.filter((c) => c.empty !== true || c.id === activeChatId);
}

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Ctrl+K or Cmd+K focuses the chat search. */
export function isSearchShortcut(e: KeyLike): boolean {
  return e.key.toLowerCase() === "k" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
}

/**
 * How far the on-screen keyboard (or any browser chrome) covers the bottom of the layout viewport,
 * from visualViewport. `dvh` follows the visual viewport on current browsers, so this is the fallback
 * for those where the layout viewport does not shrink (iOS Safari without interactive-widget support).
 */
export function keyboardInset(layoutHeight: number, vv: { height: number; offsetTop: number } | null): number {
  if (vv === null) {
    return 0;
  }
  const hidden = layoutHeight - vv.height - vv.offsetTop;
  return hidden > 0 ? Math.round(hidden) : 0;
}

/**
 * Whether an inset from `keyboardInset` is the on-screen keyboard rather than a thin strip of browser
 * chrome. iOS Safari does not shrink the layout viewport for the keyboard, so the short-viewport media
 * queries never fire there; the page flags the open keyboard itself and the CSS keys off that flag.
 */
export function keyboardOpen(inset: number): boolean {
  return inset >= 120;
}

export const WARNING_TRUNCATED = "earlier messages were left out to fit the context";
export const WARNING_TRUNCATED_TIP = "The chat history was longer than the model's context window, so the oldest messages were not sent with this reply. The model may not remember them.";

/** The amber notes for one reply: its own warning and the truncation flag. */
export function messageNotes(m: Pick<Message, "warning" | "context_truncated">): Array<{ key: "warning" | "truncated"; text: string; title?: string }> {
  const out: Array<{ key: "warning" | "truncated"; text: string; title?: string }> = [];
  if (typeof m.warning === "string" && m.warning !== "") {
    out.push({ key: "warning", text: m.warning });
  }
  if (m.context_truncated === true || m.context_truncated === 1) {
    out.push({ key: "truncated", text: WARNING_TRUNCATED, title: WARNING_TRUNCATED_TIP });
  }
  return out;
}

/** The picker/header text for how a harness keeps its memory. */
export function memoryNote(harness: Pick<HarnessOption, "memory" | "persistent"> | undefined): string {
  if (harness === undefined) {
    return "";
  }
  const kind = harness.memory ?? (harness.persistent ? "process" : "replay");
  return kind === "process" ? "one process, one turn" : kind === "session" ? "remembers via its own session" : "replays recent history";
}
