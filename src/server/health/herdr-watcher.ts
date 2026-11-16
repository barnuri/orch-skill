import type { HerdrHealth, HerdrHealthState } from "../../shared/types/run-health";
import type { HealthSpawner } from "./health-watcher";
import { homeHealthSpawner } from "./health-watcher";

/** How often the server re-checks (and self-heals) the orch herdr instance. */
export const HERDR_EVERY_SEC_DEFAULT: number = 60;
export const HERDR_TIMEOUT_MS: number = 45_000;
const MIN_EVERY_SEC: number = 10;
const STATES: readonly HerdrHealthState[] = ["ok", "degraded", "down", "off"];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses `herdr health --json`; null unless it has the contract's shape. */
export function parseHerdrHealth(text: string): HerdrHealth | null {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (!isObject(value) || !STATES.includes(value["state"] as HerdrHealthState)) {
    return null;
  }
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  return {
    state: value["state"] as HerdrHealthState,
    enabled: value["enabled"] === true,
    reason: str(value["reason"]),
    env_id: str(value["env_id"]),
    pid: typeof value["pid"] === "number" ? value["pid"] : null,
    pid_alive: value["pid_alive"] === true,
    socket_ok: value["socket_ok"] === true,
    registry: str(value["registry"]),
    registry_path: str(value["registry_path"]),
    web: str(value["web"]),
    web_url: str(value["web_url"]),
    nudged: value["nudged"] === true,
    at: str(value["at"]),
    problems: Array.isArray(value["problems"]) ? value["problems"].filter((p): p is string => typeof p === "string") : [],
  };
}

/**
 * The orch herdr instance's health, kept in memory for `/api/health/summary`. `check(true)` runs
 * `herdr health --json --nudge`, which re-ensures the instance and re-registers its herdr web env
 * when either is broken; it only ever acts on the instance under the orch state dir.
 */
export class HerdrWatcher {
  private latestEntry: HerdrHealth | null = null;
  private inFlight: Promise<HerdrHealth | null> | null = null;
  /** Whether any check has been started; the API waits for the first one only. */
  tried: boolean = false;

  constructor(private readonly spawn: HealthSpawner, private readonly log: (line: string) => void = (l) => process.stderr.write(l)) {}

  latest(): HerdrHealth | null {
    return this.latestEntry;
  }

  /** The cached check, or the first one when none has run yet (never nudges; waits at most `waitMs`). */
  async read(waitMs: number = 5_000): Promise<HerdrHealth | null> {
    if (this.latestEntry !== null || (this.tried && this.inFlight === null)) {
      return this.latestEntry;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), waitMs);
    });
    try {
      return (await Promise.race([this.check(false), late])) ?? this.latestEntry;
    } finally {
      clearTimeout(timer);
    }
  }

  /** One check at a time; a concurrent caller shares the running one. */
  check(nudge: boolean): Promise<HerdrHealth | null> {
    this.tried = true;
    if (this.inFlight === null) {
      this.inFlight = this.run(nudge).finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async run(nudge: boolean): Promise<HerdrHealth | null> {
    try {
      const r = await this.spawn(["herdr", "health", "--json", ...(nudge ? ["--nudge"] : [])], HERDR_TIMEOUT_MS);
      // Exit 1 (degraded) and 3 (down) still print the JSON.
      const health = parseHerdrHealth(r.stdout);
      if (health === null) {
        this.log(`herdr health failed (${r.code}): ${r.stderr.trim().slice(0, 200)}\n`);
        return this.latestEntry;
      }
      if (health.nudged) {
        this.log(`herdr health: re-ensured the orch herdr instance (now ${health.state})\n`);
      }
      this.latestEntry = health;
      return health;
    } catch (err) {
      this.log(`herdr health error: ${err instanceof Error ? err.message : String(err)}\n`);
      return this.latestEntry;
    }
  }
}

const watchers = new Map<string, HerdrWatcher>();

/** The one herdr watcher per state directory. */
export function herdrWatcherFor(home: string): HerdrWatcher {
  let w = watchers.get(home);
  if (w === undefined) {
    w = new HerdrWatcher(homeHealthSpawner(home));
    watchers.set(home, w);
  }
  return w;
}

/** ORCH_HERDR_HEALTH_EVERY_SEC, else 60; never under 10. */
export function herdrEverySec(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env["ORCH_HERDR_HEALTH_EVERY_SEC"]);
  return Number.isInteger(n) && n > 0 ? Math.max(MIN_EVERY_SEC, n) : HERDR_EVERY_SEC_DEFAULT;
}

/** Server startup: check now, then every herdrEverySec() with --nudge, so a dead instance comes back. */
export function startHerdrWatcher(home: string): { watcher: HerdrWatcher; stop(): void } {
  const watcher = herdrWatcherFor(home);
  void watcher.check(true);
  const timer = setInterval(() => {
    void watcher.check(true);
  }, herdrEverySec() * 1000);
  timer.unref?.();
  return { watcher, stop: () => clearInterval(timer) };
}
