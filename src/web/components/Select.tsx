import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectProps {
  id?: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (next: string) => void;
  "aria-label"?: string;
  disabled?: boolean;
  invalid?: boolean;
}

/** Index to highlight after a key press: arrows step, Home/End jump, anything else keeps it. */
export function nextActive(key: string, active: number, count: number): number {
  if (key === "ArrowDown") {
    return Math.min(count - 1, active + 1);
  }
  if (key === "ArrowUp") {
    return Math.max(0, active - 1);
  }
  if (key === "Home") {
    return 0;
  }
  return key === "End" ? count - 1 : active;
}

/** A styled listbox in place of the browser's native select; one tab stop, arrow/Enter/Escape keys. */
export function Select({ id, value, options, onChange, disabled = false, invalid = false, ...aria }: SelectProps) {
  const autoId = useId();
  const listId = `${autoId}-list`;
  const [open, setOpen] = useState(false);
  const found = options.findIndex((option) => option.value === value);
  const selected = Math.max(0, found);
  const [active, setActive] = useState(selected);
  const root = useRef<HTMLDivElement>(null);
  const rows = useRef<(HTMLLIElement | null)[]>([]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onDown = (event: MouseEvent): void => {
      if (root.current !== null && event.target instanceof Node && !root.current.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      rows.current[active]?.scrollIntoView?.({ block: "nearest" });
    }
  }, [open, active]);

  const openList = (): void => {
    setActive(selected);
    setOpen(true);
  };
  const choose = (index: number): void => {
    const option = options[index];
    if (option !== undefined && option.disabled !== true) {
      onChange(option.value);
    }
    setOpen(false);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      if (!open) {
        openList();
      } else {
        setActive(nextActive(event.key, active, options.length));
      }
    } else if ((event.key === "Enter" || event.key === " ") && open) {
      event.preventDefault();
      choose(active);
    } else if (event.key === "Escape" && open) {
      event.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className="select" ref={root}>
      <button
        id={id}
        className="select-btn"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-invalid={invalid || undefined}
        aria-label={aria["aria-label"]}
        disabled={disabled}
        onClick={() => {
          if (open) {
            setOpen(false);
          } else {
            openList();
          }
        }}
        onKeyDown={onKeyDown}
      >
        <span className="select-value">{found < 0 ? "" : (options[found]?.label ?? "")}</span>
        <svg className="select-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <path d="m4 6 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <ul id={listId} className="select-list" role="listbox" tabIndex={-1} hidden={!open}>
        {options.map((option, index) => (
          <li
            key={option.value}
            ref={(node) => {
              rows.current[index] = node;
            }}
            className="select-opt"
            role="option"
            aria-selected={index === found}
            aria-disabled={option.disabled || undefined}
            data-active={index === active}
            onMouseMove={() => {
              setActive(index);
            }}
            onClick={() => {
              choose(index);
            }}
          >
            {option.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
