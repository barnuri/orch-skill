import { useEffect, useId, useRef, useState } from "react";
import { nextActive } from "../components/Select";

export interface PickerOption {
  value: string;
  label: string;
  /** Mono secondary text, e.g. the model id. */
  detail?: string;
  description?: string;
  /** Why the row cannot be chosen. Presence disables it. */
  disabledReason?: string | null;
}

interface PickerSelectProps {
  label: string;
  value: string;
  options: readonly PickerOption[];
  onChange: (value: string) => void;
  disabled: boolean;
  /** Shown as the button's tooltip and under the label when the select is disabled. */
  note?: string | null;
  testId: string;
}

/** A list this long or longer gets a search box in its popup. */
const SEARCH_MIN_OPTIONS = 8;

/** Every word of the query must appear in the option's label, value, id or description (case-insensitive). */
function matchesQuery(option: PickerOption, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term !== "");
  const text = [option.label, option.value, option.detail ?? "", option.description ?? ""].join(" ").toLowerCase();
  return terms.every((term) => text.includes(term));
}

/** The app's listbox with richer rows (id, description, disabled reason) for the chat pickers. */
export function PickerSelect({ label, value, options, onChange, disabled, note, testId }: PickerSelectProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const found = options.findIndex((o) => o.value === value);
  const shown = options.filter((o) => matchesQuery(o, query));
  const shownFound = shown.findIndex((o) => o.value === value);
  const [active, setActive] = useState(Math.max(0, found));
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const searchable = options.length >= SEARCH_MIN_OPTIONS;

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const onDown = (event: Event): void => {
      if (root.current !== null && event.target instanceof Node && !root.current.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    if (searchable && window.matchMedia("(pointer: fine)").matches) {
      search.current?.focus();
    }
    return () => {
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open, searchable]);

  const choose = (index: number): void => {
    const option = shown[index];
    if (option !== undefined && !option.disabledReason) {
      onChange(option.value);
      setOpen(false);
    }
  };
  const onKeyDown = (event: React.KeyboardEvent): void => {
    const typing = event.target instanceof HTMLInputElement;
    if (typing && (event.key === "Home" || event.key === "End")) {
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (!open) {
        setActive(Math.max(0, found));
        setOpen(true);
      } else {
        setActive(nextActive(event.key, active, shown.length));
      }
    } else if (event.key === "Enter" && open) {
      event.preventDefault();
      choose(active);
    } else if (event.key === " " && open && !typing) {
      event.preventDefault();
      choose(active);
    } else if (event.key === "Escape" && open) {
      event.stopPropagation();
      setOpen(false);
    }
  };
  const current = found >= 0 ? options[found] : undefined;
  return (
    <div className="picker" ref={root} data-testid={testId} data-disabled={disabled || undefined}>
      <label className="picker-label" htmlFor={id}>
        {label}
      </label>
      <button
        id={id}
        type="button"
        className="select-btn picker-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        title={note ?? undefined}
        onClick={() => {
          setActive(Math.max(0, found));
          setOpen(!open);
        }}
        onKeyDown={onKeyDown}
      >
        <span className="select-value">{current?.label ?? (note ?? "—")}</span>
        <svg className="select-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <path d="m4 6 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {disabled && note ? <span className="picker-note">{note}</span> : null}
      <div className="select-list picker-list picker-pop" hidden={!open}>
        {searchable ? (
          <input
            ref={search}
            type="search"
            className="picker-search"
            placeholder={`Search ${label.toLowerCase()}`}
            aria-label={`Search ${label.toLowerCase()}`}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
        ) : null}
        <ul className="picker-items" role="listbox" aria-label={label}>
          {shown.map((option, index) => (
            <li
              key={option.value}
              className="select-opt picker-opt"
              role="option"
              aria-selected={index === shownFound}
              aria-disabled={option.disabledReason ? true : undefined}
              data-active={index === active}
              onMouseMove={() => {
                setActive(index);
              }}
              onClick={() => {
                choose(index);
              }}
            >
              <span className="picker-opt-main">{option.label}</span>
              {option.detail ? <span className="picker-opt-id">{option.detail}</span> : null}
              {option.description ? <span className="picker-opt-desc">{option.description}</span> : null}
              {option.disabledReason ? <span className="picker-opt-why">{option.disabledReason}</span> : null}
            </li>
          ))}
          {shown.length === 0 ? <li className="picker-empty" role="presentation">No match</li> : null}
        </ul>
      </div>
    </div>
  );
}
