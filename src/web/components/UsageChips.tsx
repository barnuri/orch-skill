import type { Use } from "../../shared/profile-usage";
import { USE_LABEL } from "../lib/usage-ui";

interface UseState {
  on: boolean;
  /** A reason the chip cannot change (the harness is off for this use), or null. */
  lock: string | null;
}

interface Props {
  name: string;
  chat: UseState;
  runs: UseState;
  busy?: boolean;
  /** True when turning this one off would leave both uses off. */
  lastOn: (use: Use) => boolean;
  onChange: (use: Use, on: boolean) => void;
}

/** Two switch chips, `Chat` and `Orch runs`: each saves at once. A locked chip shows its reason on one line. */
export function UsageChips({ name, chat, runs, busy = false, lastOn, onChange }: Props) {
  const items: Array<[Use, UseState]> = [["chat", chat], ["runs", runs]];
  const reason = items.find(([, s]) => s.lock !== null)?.[1].lock ?? null;
  return (
    <div className="usage-chips" role="group" aria-label={`Where ${name} can be used`} onClick={(event) => { event.stopPropagation(); }}>
      {items.map(([use, state]) => {
        const last = state.on && lastOn(use);
        const title = state.lock ?? (last ? "At least one use must stay on" : `${state.on ? "Turn off" : "Turn on"} ${USE_LABEL[use]} for ${name}`);
        return (
          <button
            key={use}
            type="button"
            role="switch"
            aria-checked={state.on}
            aria-label={`${USE_LABEL[use]} for ${name}`}
            className={state.on ? "usage-chip is-on" : "usage-chip"}
            title={title}
            disabled={busy || state.lock !== null || last}
            onClick={() => { onChange(use, !state.on); }}
          >
            {USE_LABEL[use]}
          </button>
        );
      })}
      {reason === null ? null : <span className="usage-reason">{reason}</span>}
    </div>
  );
}
