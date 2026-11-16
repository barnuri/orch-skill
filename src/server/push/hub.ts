import { CATEGORY_TTL_S, type PushCategory, type PushMessage, inQuietHours, notificationBody, redactSecrets } from "../../shared/push";
import { SubscriptionStore, type Subscription } from "./store";
import { type PushTarget, type SendResult, type VapidKeys, loadOrCreateVapid, sendPush, topicFor } from "./webpush";

/** A heartbeat this recent from a visible, focused page of a chat means the person is reading it. */
export const VISIBLE_SUPPRESS_MS = 3000;

export interface NotifyInput {
  title?: string;
  body: string;
  /** One notification per tag: a later one replaces the earlier (per chat, per run). */
  tag: string;
  url: string;
  chatId?: string;
  runId?: string;
  icon?: "chat" | "dashboard";
  actions?: { action: string; title: string }[];
  /** Counts toward the badge of chats that wait for the person. */
  waiting?: boolean;
}

export interface NotifyReport {
  sent: number;
  suppressed: "visible" | null;
  skipped: number;
}

export type Sender = (keys: VapidKeys, target: PushTarget, payload: unknown, opts: { category: PushCategory; topic?: string }) => Promise<SendResult>;

export interface HubOptions {
  now?: () => number;
  send?: Sender;
}

const MAX_ACTIONS = 2;

export class PushHub {
  private keys: VapidKeys | null = null;
  private readonly visibleAt = new Map<string, number>();
  private readonly waiting = new Set<string>();
  private readonly now: () => number;
  private readonly send: Sender;
  readonly store: SubscriptionStore;

  constructor(private readonly home: string, opts: HubOptions = {}) {
    this.store = new SubscriptionStore(home);
    this.now = opts.now ?? Date.now;
    this.send = opts.send ?? ((keys, target, payload, o) => sendPush(keys, target, payload, o));
  }

  private attached = false;

  /** Runs `attach` the first time only: every server built on this home shares one hub and one chat hook. */
  attachOnce(attach: () => void): void {
    if (this.attached) return;
    this.attached = true;
    attach();
  }

  async vapid(): Promise<VapidKeys> {
    this.keys ??= await loadOrCreateVapid(this.home);
    return this.keys;
  }

  /** The page reports it is (not) on screen. `chatId` null means the dashboard, which no chat suppression applies to. */
  presence(chatId: string | null, visible: boolean, focused: boolean): void {
    if (chatId === null) return;
    if (visible && focused) {
      this.visibleAt.set(chatId, this.now());
      this.waiting.delete(chatId);
    } else {
      this.visibleAt.delete(chatId);
    }
  }

  isLookingAt(chatId: string): boolean {
    const at = this.visibleAt.get(chatId);
    return at !== undefined && this.now() - at < VISIBLE_SUPPRESS_MS;
  }

  badge(): number {
    return this.waiting.size;
  }

  clearWaiting(chatId: string): void {
    this.waiting.delete(chatId);
  }

  message(category: PushCategory, input: NotifyInput): PushMessage {
    const actions = (input.actions ?? []).slice(0, MAX_ACTIONS);
    const icon = input.icon ?? (input.chatId === undefined ? "dashboard" : "chat");
    const data = { url: input.url, tag: input.tag, category, ...(input.chatId === undefined ? {} : { chat_id: input.chatId }), ...(input.runId === undefined ? {} : { run_id: input.runId }) };
    return {
      title: redactSecrets(input.title ?? "Orch").slice(0, 80),
      body: notificationBody(redactSecrets(input.body), 140),
      tag: input.tag,
      url: input.url,
      category,
      badge: input.chatId === undefined ? null : this.waiting.size,
      icon,
      actions: [{ action: "open", title: "Open" }, ...actions.slice(0, MAX_ACTIONS - 1)],
      data,
    };
  }

  wants(sub: Subscription, category: PushCategory): boolean {
    return sub.categories.includes(category) && !inQuietHours(sub.quiet, this.now());
  }

  async notify(category: PushCategory, input: NotifyInput): Promise<NotifyReport> {
    if (input.chatId !== undefined && this.isLookingAt(input.chatId)) return { sent: 0, suppressed: "visible", skipped: 0 };
    const all = this.store.list();
    const eligible = all.filter((s) => this.wants(s, category));
    // Both installed apps may be subscribed on one device: each event goes to the app it belongs to, so it shows once.
    const home: Subscription["app"] = input.chatId === undefined ? "dashboard" : "chat";
    const targets = eligible.some((s) => s.app === home) ? eligible.filter((s) => s.app === home) : eligible;
    const skipped = all.length - eligible.length;
    if (targets.length === 0) return { sent: 0, suppressed: null, skipped };
    if (input.waiting === true && input.chatId !== undefined) this.waiting.add(input.chatId);
    const payload = this.message(category, input);
    const keys = await this.vapid();
    const results = await Promise.all(targets.map((s) => this.deliver(keys, s, payload, category)));
    return { sent: results.filter(Boolean).length, suppressed: null, skipped };
  }

  /** Sends to one device regardless of its category filters (the Test button). */
  async test(id: string): Promise<SendResult | null> {
    const sub = this.store.get(id);
    if (sub === null) return null;
    const payload = this.message("replies", { title: "Orch", body: "Notifications work on this device.", tag: "orch-test", url: sub.app === "chat" ? "/chat/" : "/", icon: sub.app });
    return this.deliverRaw(await this.vapid(), sub, payload, "replies");
  }

  private async deliverRaw(keys: VapidKeys, sub: Subscription, payload: PushMessage, category: PushCategory): Promise<SendResult> {
    const res = await this.send(keys, { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, payload, { category, topic: topicFor(payload.tag) });
    if (res.ok) this.store.recordResult(sub.id, true, null);
    else if (res.gone) this.store.remove(sub.id);
    else this.store.recordResult(sub.id, false, res.error);
    return res;
  }

  private async deliver(keys: VapidKeys, sub: Subscription, payload: PushMessage, category: PushCategory): Promise<boolean> {
    const own = { ...payload, icon: sub.app };
    return (await this.deliverRaw(keys, sub, own, category)).ok;
  }
}

const hubs = new Map<string, PushHub>();

/** One hub per orch home: the controllers, the chat hook and the run watcher share its subscriptions and presence. */
export function pushHubFor(home: string, opts?: HubOptions): PushHub {
  let hub = hubs.get(home);
  if (hub === undefined) {
    hub = new PushHub(home, opts);
    hubs.set(home, hub);
  }
  return hub;
}

export function resetPushHubs(): void {
  hubs.clear();
}

export { CATEGORY_TTL_S };
