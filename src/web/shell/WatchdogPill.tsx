import type { WatchdogAction, WatchdogFlag, WatchdogStatus } from "../../shared/types/watchdog";

export type WatchdogPillState = "off" | "ok" | "stalled" | "error";

/** Rules whose flag means a node failed on infrastructure and the watchdog ran out of retries. Only these are red. */
const ERROR_RULES: ReadonlySet<WatchdogFlag["rule"]> = new Set(["infra-retry", "lost"]);

/**
 * Red only for a node in error the watchdog gave up on. Any other flag (stalled, unverified, info)
 * is amber. Off is grey, no flag is green.
 */
export function watchdogPillState(status: WatchdogStatus): WatchdogPillState {
  if (status.state === "off") {
    return "off";
  }
  if (status.flags.some((f) => ERROR_RULES.has(f.rule))) {
    return "error";
  }
  return status.flags.length > 0 || status.ghosts > 0 ? "stalled" : "ok";
}

/** `retried r1/a`, `finished r1`, `flagged r1/a stalled`: the last action in a few words. */
export function describeAction(a: WatchdogAction): string {
  const where = a.node === null ? a.run : `${a.run}/${a.node}`;
  if (a.action === "flag") {
    return `flagged ${where} ${a.rule}`;
  }
  return `${a.action} ${where}`;
}

/**
 * Header pill for the server's run watchdog: its state (off, ok, amber for a stalled or unverified node,
 * red when a node is out of retries) and its last action. Hidden before the first answer.
 */
export function WatchdogPill({ status }: { status: WatchdogStatus | null | undefined }) {
  if (status === null || status === undefined) {
    return null;
  }
  const state = watchdogPillState(status);
  const last = status.last_actions[0];
  const lastText = last === undefined ? "no actions yet" : describeAction(last);
  const flags = status.flags.map((f) => `${f.run}/${f.node} ${f.rule}: ${f.detail}`);
  const ghostText = status.ghosts > 0 ? `${status.ghosts} ghost runner${status.ghosts === 1 ? "" : "s"}` : "";
  const title = [
    `run watchdog: ${status.state}`,
    last === undefined ? "no actions yet" : `last: ${describeAction(last)} (${last.detail}) at ${last.at}`,
    ...(ghostText ? [ghostText] : []),
    ...flags,
  ].join("\n");
  return (
    <span
      className={`active-pill watchdog-pill is-${state}`}
      id="watchdog-pill"
      data-state={state}
      role="status"
      title={title}
      aria-label={`watchdog ${state}, ${lastText}${flags.length > 0 ? `, ${flags.length} flagged` : ""}`}
    >
      <span className="dot" />
      <span>
        watchdog<span className="watchdog-pill-words">{state === "off" ? " off" : ` · ${lastText}`}</span>
        {ghostText ? <span className="watchdog-pill-words">{` · ${ghostText}`}</span> : null}
      </span>
    </span>
  );
}
