import { resolve } from "node:path";

import { isRunId } from "./run-id";

const DISPATCH: string = resolve(import.meta.dir, "../../../skills/orch/scripts/dispatch.sh");
export const ACTIVITY_MESSAGES = 20;
export const ACTIVITY_MAX_BYTES = 8192;
export const ACTIVITY_CACHE_MS = 5_000;
export const ACTIVITY_TIMEOUT_MS = 3_500;
const MAX_PARTS = 3;
const TEXT_CHARS = 400;
const REASONING_CHARS = 160;
const TOOL_INPUT_CHARS = 120;

export interface ActivityPart {
  kind: "text" | "tool" | "reasoning";
  text: string;
  tool?: string;
}

export interface ActivityMessage {
  id: string;
  role: string;
  time: string | null;
  parts: ActivityPart[];
}

export interface ActivityBody {
  state: "ok" | "gone" | "unknown";
  messages: ActivityMessage[];
  next: string | null;
}

export type ActivityResult = { kind: "none" } | { kind: "ok"; body: ActivityBody };
export type RawSpawner = (runId: string, nodeId: string, timeoutMs: number) => Promise<{ code: number; stdout: string }>;

function clip(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value);
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function iso(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  return typeof value === "string" && value !== "" ? value : null;
}

function toolLine(input: unknown): string {
  if (input && typeof input === "object") {
    const first = Object.values(input as Record<string, unknown>).find((v) => typeof v === "string" || typeof v === "number");
    return clip(first ?? input, TOOL_INPUT_CHARS);
  }
  return clip(input, TOOL_INPUT_CHARS);
}

export function reduceMessage(raw: Record<string, unknown>): ActivityMessage {
  const content = (raw.content ?? raw.parts ?? []) as unknown;
  const parts: ActivityPart[] = [];
  for (const p of Array.isArray(content) ? (content as Record<string, unknown>[]) : []) {
    if (parts.length >= MAX_PARTS || !p || typeof p !== "object") {
      continue;
    }
    if (p.type === "text") {
      parts.push({ kind: "text", text: clip(p.text, TEXT_CHARS) });
    } else if (p.type === "reasoning") {
      parts.push({ kind: "reasoning", text: clip(p.text ?? p.reasoning, REASONING_CHARS) });
    } else if (p.type === "tool") {
      const state = (p.state ?? {}) as Record<string, unknown>;
      parts.push({ kind: "tool", tool: clip(p.tool ?? p.name, 60), text: toolLine(p.input ?? state.input) });
    }
  }
  const time = (raw.time ?? {}) as Record<string, unknown>;
  return {
    id: clip(raw.id, 80),
    role: clip(raw.role ?? raw.type, 20),
    time: iso(time.created ?? time.completed ?? raw.created),
    parts,
  };
}

/** Raw opencode answer (newest first) to a bounded, oldest-first summary under ACTIVITY_MAX_BYTES. */
export function reduceActivity(rawJson: string, after: string | null): ActivityBody {
  let data: unknown;
  try {
    data = (JSON.parse(rawJson) as { data?: unknown }).data;
  } catch {
    return { state: "unknown", messages: [], next: null };
  }
  if (!Array.isArray(data)) {
    return { state: "unknown", messages: [], next: null };
  }
  let messages = (data as Record<string, unknown>[]).slice(0, ACTIVITY_MESSAGES).reverse().map(reduceMessage);
  if (after !== null) {
    const at = messages.findIndex((m) => m.id === after);
    messages = at === -1 ? messages : messages.slice(at + 1);
  }
  while (messages.length > 1 && JSON.stringify(messages).length > ACTIVITY_MAX_BYTES) {
    messages = messages.slice(1);
  }
  const last = messages[messages.length - 1];
  return { state: "ok", messages, next: last ? last.id : after };
}

async function spawnRaw(home: string, runId: string, nodeId: string, timeoutMs: number): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(["bash", DISPATCH, "node", "activity", runId, nodeId], {
    env: { ...process.env, HARNESS_ORCH_HOME: home, ORCH_NO_ANNOUNCE: "1", ORCH_OWNER_CALL_TIMEOUT: "3" },
    stdout: "pipe",
    stderr: "ignore",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, stdout };
}

export function homeSpawner(home: string): RawSpawner {
  return (runId, nodeId, timeoutMs) => spawnRaw(home, runId, nodeId, timeoutMs);
}

/** One opencode call at a time (a promise chain), the raw answer cached 5 s per node. */
export class OwnerActivityReader {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly cache = new Map<string, { at: number; result: { code: number; stdout: string } }>();

  constructor(
    private readonly spawn: RawSpawner,
    private readonly now: () => number = Date.now,
  ) {}

  async read(runId: string, nodeId: string, after: string | null): Promise<ActivityResult> {
    if (!isRunId(runId) || !isRunId(nodeId)) {
      return { kind: "none" };
    }
    const key = `${runId}/${nodeId}`;
    const hit = this.cache.get(key);
    let raw: { code: number; stdout: string };
    if (hit && this.now() - hit.at < ACTIVITY_CACHE_MS) {
      raw = hit.result;
    } else {
      const run = this.chain.then(() => this.spawn(runId, nodeId, ACTIVITY_TIMEOUT_MS).catch(() => ({ code: 1, stdout: "" })));
      this.chain = run.catch(() => undefined);
      raw = await run;
      this.cache.set(key, { at: this.now(), result: raw });
    }
    if (raw.code === 4 || raw.code === 2) {
      return { kind: "none" };
    }
    if (raw.code === 3) {
      return { kind: "ok", body: { state: "gone", messages: [], next: null } };
    }
    if (raw.code !== 0) {
      return { kind: "ok", body: { state: "unknown", messages: [], next: null } };
    }
    return { kind: "ok", body: reduceActivity(raw.stdout, after) };
  }
}
