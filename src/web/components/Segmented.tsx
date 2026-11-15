import type { KeyboardEvent } from "react";
import { useRef } from "react";

export interface SegmentedOption {
  value: string;
  label: string;
}

interface SegmentedProps {
  label: string;
  value: string;
  options: readonly SegmentedOption[];
  onChange: (next: string) => void;
}

/** Step of an arrow key inside a radio group; 0 for any other key. */
export function arrowStep(key: string): number {
  if (key === "ArrowRight" || key === "ArrowDown") {
    return 1;
  }
  return key === "ArrowLeft" || key === "ArrowUp" ? -1 : 0;
}

/** A flat radio group for a short list of views or ranges. Arrow keys move the choice (one tab stop). */
export function Segmented({ label, value, options, onChange }: SegmentedProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (event: KeyboardEvent, index: number): void => {
    const step = arrowStep(event.key);
    if (step === 0) {
      return;
    }
    event.preventDefault();
    const at = (index + step + options.length) % options.length;
    const next = options[at];
    if (next !== undefined) {
      onChange(next.value);
      refs.current[at]?.focus();
    }
  };
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            className="seg-opt"
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => {
              if (!checked) {
                onChange(option.value);
              }
            }}
            onKeyDown={(event) => {
              onKeyDown(event, index);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A labelled wrapper for a control that has no native label of its own. */
export function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field-group">
      <span className="field-label">{label}</span>
      {children}
    </div>
  );
}
