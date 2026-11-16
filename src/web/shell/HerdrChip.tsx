import type { HerdrHealth, HerdrHealthState } from "../../shared/types/run-health";

const WORDS: Record<Exclude<HerdrHealthState, "off">, string> = {
  ok: "herdr ok",
  degraded: "herdr degraded",
  down: "herdr down",
};

/**
 * Header chip for the orch skill's own herdr instance (herdr web env `orch-skill`): green ok,
 * amber degraded, red down. Hidden when herdr is off or before the first check.
 */
export function HerdrChip({ health }: { health: HerdrHealth | null | undefined }) {
  if (health === null || health === undefined || health.state === "off") {
    return null;
  }
  const state = health.state;
  const detail = health.problems.length > 0 ? health.problems.join("; ") : `env ${health.env_id || "orch-skill"} is up and listed in herdr web`;
  return (
    <span
      className={`active-pill herdr-chip is-${state}`}
      id="herdr-chip"
      data-state={state}
      role="status"
      title={`orch herdr instance: ${state}. ${detail}`}
      aria-label={`${WORDS[state]}: ${detail}`}
    >
      <span className="dot" />
      <span>
        herdr<span className="herdr-chip-words">{state === "ok" ? "" : ` ${state}`}</span>
      </span>
    </span>
  );
}
