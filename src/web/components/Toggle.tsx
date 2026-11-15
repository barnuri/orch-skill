import type { MouseEvent } from "react";

interface ToggleProps {
  label: string;
  on: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  title?: string;
  /** `switch` is the compact track used inside table rows; `track` is the standalone control. */
  variant?: "track" | "switch";
}

/** An on/off switch that applies at once. The label names what it controls, since it shows no text. */
export function Toggle({ label, on, onChange, disabled = false, title, variant = "track" }: ToggleProps) {
  const onClick = (event: MouseEvent): void => {
    event.stopPropagation();
    if (!disabled) {
      onChange(!on);
    }
  };
  if (variant === "switch") {
    return (
      <button
        className={on ? "switch is-on" : "switch"}
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        title={title ?? label}
        disabled={disabled}
        onClick={onClick}
      >
        <span className="switch-thumb" />
      </button>
    );
  }
  return (
    <button
      className="toggle"
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={title ?? (on ? "On" : "Off")}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="toggle-track">
        <span className="toggle-knob" />
      </span>
    </button>
  );
}
