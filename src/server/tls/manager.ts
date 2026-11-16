import { type TlsConfig } from "./config";
import { type TlsDeps, type TlsMaterial, type TlsSource, realDeps, resolveTls } from "./sources";

export const CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Public view of the HTTPS listener: never holds a key. */
export interface TlsStatus {
  enabled: boolean;
  port: number;
  listening: boolean;
  source: TlsSource | null;
  not_after: string | null;
  names: string[];
  ca_fingerprint: string | null;
  /** Why HTTPS is not up, or why a better route was not used. */
  problem: string | null;
  problems: string[];
  warning: string | null;
}

export interface TlsRuntime {
  status(): TlsStatus;
  /** Public CA certificate a device must trust, or null. */
  caPem(): string | null;
}

export const SELF_SIGNED_WARNING = "self-signed: browsers warn once";
export const LOCAL_CA_NOTE = "local CA: trust the CA once on each device, then no warnings";

export function offStatus(): TlsStatus {
  return { enabled: false, port: 0, listening: false, source: null, not_after: null, names: [], ca_fingerprint: null, problem: null, problems: [], warning: null };
}

export class TlsManager implements TlsRuntime {
  private current: TlsMaterial | null = null;
  private problem: string | null = null;
  private problems: string[] = [];
  private listening = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly home: string,
    private readonly cfg: TlsConfig,
    private readonly onChange: (m: TlsMaterial) => void,
    private readonly deps: TlsDeps = realDeps(),
  ) {}

  /** Resolves the certificate (generating it when missing). Never throws. */
  async load(force = false): Promise<TlsMaterial | null> {
    try {
      const r = await resolveTls(this.home, this.cfg, this.deps, { force });
      this.problems = r.problems;
      this.problem = r.material === null ? r.problem : null;
      if (r.material !== null) this.current = r.material;
      return r.material;
    } catch (e) {
      this.problem = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  setListening(up: boolean, problem: string | null = null): void {
    this.listening = up;
    if (problem !== null) this.problem = problem;
  }

  /** Re-checks expiry and names; calls onChange only when the certificate changed. */
  async check(): Promise<void> {
    const before = this.current?.cert ?? null;
    const m = await this.load();
    if (m !== null && m.cert !== before) this.onChange(m);
  }

  startTimer(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  material(): TlsMaterial | null {
    return this.current;
  }

  caPem(): string | null {
    return this.current?.caPem ?? null;
  }

  status(): TlsStatus {
    const m = this.current;
    return {
      enabled: true,
      port: this.cfg.httpsPort,
      listening: this.listening,
      source: m?.source ?? null,
      not_after: m === null ? null : m.notAfter.toISOString(),
      names: m?.names ?? [],
      ca_fingerprint: m?.caFingerprint ?? null,
      problem: this.problem,
      problems: this.problems,
      warning: m === null ? null : m.source === "selfsigned" ? SELF_SIGNED_WARNING : m.source === "localca" ? LOCAL_CA_NOTE : null,
    };
  }
}

/** The host to put in the https link: the one the request used when the cert covers it, else a covered name. */
export function secureHostFor(names: readonly string[], requestHost: string): string {
  const host = requestHost.toLowerCase();
  if (names.length === 0 || names.includes(host)) return host;
  const named = names.find((n) => n !== "localhost" && !n.includes(":") && !/^\d+(\.\d+){3}$/.test(n) && n.includes("."));
  return named ?? names.find((n) => n !== "localhost") ?? host;
}
