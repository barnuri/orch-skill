import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DEFAULT_QUIET_HOURS, PUSH_CATEGORIES, type PushCategory, type QuietHours } from "../../shared/push";

export interface Subscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  user_agent: string;
  app: "chat" | "dashboard";
  created_at: string;
  last_success_at: string | null;
  last_error: string | null;
  categories: PushCategory[];
  quiet: QuietHours;
}

export const subscriptionId = (endpoint: string): string => createHash("sha256").update(endpoint).digest("hex").slice(0, 16);

/** A small JSON file (0600): endpoints and keys are bearer secrets of the push service, so they are never listed back whole. */
export class SubscriptionStore {
  private readonly file: string;
  private subs: Subscription[];

  constructor(home: string) {
    this.file = join(home, "push", "subscriptions.json");
    this.subs = this.read();
  }

  private read(): Subscription[] {
    if (!existsSync(this.file)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { subscriptions?: Subscription[] };
      return Array.isArray(raw.subscriptions) ? raw.subscriptions : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ subscriptions: this.subs }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
  }

  list(): Subscription[] {
    return this.subs.map((s) => ({ ...s }));
  }

  get(id: string): Subscription | null {
    return this.subs.find((s) => s.id === id) ?? null;
  }

  /** Same endpoint again replaces the record's keys and settings in place (a page re-subscribes after an update). */
  upsert(input: Pick<Subscription, "endpoint" | "p256dh" | "auth" | "label" | "user_agent" | "app"> & { categories?: PushCategory[]; quiet?: QuietHours }, now = new Date()): Subscription {
    const id = subscriptionId(input.endpoint);
    const old = this.get(id);
    const next: Subscription = {
      id,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      label: input.label.slice(0, 80),
      user_agent: input.user_agent.slice(0, 300),
      app: input.app,
      created_at: old?.created_at ?? now.toISOString(),
      last_success_at: old?.last_success_at ?? null,
      last_error: null,
      categories: input.categories ?? old?.categories ?? [...PUSH_CATEGORIES],
      quiet: input.quiet ?? old?.quiet ?? { ...DEFAULT_QUIET_HOURS },
    };
    this.subs = [...this.subs.filter((s) => s.id !== id), next];
    this.save();
    return next;
  }

  update(id: string, patch: Partial<Pick<Subscription, "categories" | "quiet" | "label">>): Subscription | null {
    const cur = this.get(id);
    if (cur === null) return null;
    const next = { ...cur, ...patch };
    this.subs = this.subs.map((s) => (s.id === id ? next : s));
    this.save();
    return next;
  }

  remove(id: string): boolean {
    const had = this.subs.some((s) => s.id === id);
    if (had) {
      this.subs = this.subs.filter((s) => s.id !== id);
      this.save();
    }
    return had;
  }

  recordResult(id: string, ok: boolean, error: string | null, now = new Date()): void {
    const cur = this.get(id);
    if (cur === null) return;
    this.subs = this.subs.map((s) => (s.id === id ? { ...s, last_success_at: ok ? now.toISOString() : s.last_success_at, last_error: ok ? null : error } : s));
    this.save();
  }
}
