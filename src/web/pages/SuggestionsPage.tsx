import "./pages-b.css";
import { useState } from "react";
import type { Suggestion } from "../../shared/types/suggestion";
import { CONFIDENCE_VALUES, SUGGESTION_STATUSES } from "../../shared/types/routing-enums";
import { api } from "../api/client";
import { describeFailure } from "../api/result";
import { invalidateDocument, useDocument } from "../api/queries";
import { Button } from "../components/Button";
import { Checkbox } from "../components/Checkbox";
import { Chip } from "../components/Chip";
import { PageHead } from "../components/PageHead";
import { Select } from "../components/Select";
import { useToast } from "../components/Toast";
import { asSuggestionsDocument } from "../lib/documents";
import { useSessionState } from "../lib/session-state";
import {
  ALL_VALUE,
  applyToastFor,
  DEFAULT_FILTERS,
  filtersActive,
  isApplicable,
  kindLabel,
  kindOptions,
  matchesFilters,
  pendingCount,
  previewText,
  sortSuggestions,
} from "../lib/suggestion-logic";
import type { SuggestionFilters } from "../lib/suggestion-logic";

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (next: string) => void;
}) {
  return (
    <div className="filter-field">
      <span className="filter-label">{label}</span>
      <Select aria-label={label} value={value} options={options} onChange={onChange} />
    </div>
  );
}

function SuggestionCard({
  item,
  selected,
  busy,
  onSelect,
  onApply,
  onDismiss,
}: {
  item: Suggestion;
  selected: boolean;
  busy: boolean;
  onSelect: (checked: boolean) => void;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const applicable = isApplicable(item);
  const preview = previewText(item);
  return (
    <article className={`suggestion-card status-${item.status}`} role="listitem">
      <div className="suggestion-head">
        <div className="suggestion-chips">
          {applicable ? <Checkbox aria-label={`Select ${item.title}`} checked={selected} onChange={onSelect} /> : null}
          <Chip status={item.confidence} />
          <Chip status={item.kind} />
          <Chip status={item.status} />
        </div>
        <h2 className="suggestion-title">{item.title}</h2>
      </div>
      <p className="suggestion-reason">{item.reason}</p>
      {preview === null ? null : <p className="suggestion-preview muted">{preview}</p>}
      <div className="suggestion-evidence">
        {item.evidence
          .filter((ref) => ref.type === "run" && ref.id !== undefined)
          .map((ref) => (
            <a key={ref.id} className="text-link" href={`#/run/${encodeURIComponent(ref.id ?? "")}`}>
              {ref.id}
            </a>
          ))}
      </div>
      <div className="actions">
        {item.status === "pending" ? (
          <>
            {applicable ? (
              <Button variant="primary" disabled={busy} onClick={onApply}>
                Apply
              </Button>
            ) : (
              <span className="muted">Not auto-applicable yet</span>
            )}
            <Button disabled={busy} onClick={onDismiss}>
              Dismiss
            </Button>
          </>
        ) : null}
      </div>
    </article>
  );
}

/** The `#/suggestions` page: what the learning scan proposes, with filters, apply and dismiss. */
export function SuggestionsPage() {
  const toast = useToast();
  const query = useDocument("suggestions");
  const [filters, setFilters] = useSessionState<SuggestionFilters>("suggestion-filters", { ...DEFAULT_FILTERS });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const loaded = asSuggestionsDocument(query.data?.document);
  const items = loaded?.suggestions ?? [];
  const catalog = query.data?.enums ?? [];
  const filtered = items.filter((item) => matchesFilters(item, filters));
  const applicable = filtered.filter(isApplicable);
  const allIds = applicable.map((s) => s.id);

  const refresh = (): void => {
    void invalidateDocument("suggestions");
  };
  const runApply = (ids: string[] | undefined, all: boolean): void => {
    if (applying) {
      return;
    }
    setApplying(true);
    void api.applySuggestions(ids, all).then((result) => {
      setApplying(false);
      setSelected(new Set());
      if (result.kind === "ok") {
        const message = applyToastFor(result.body);
        toast(message.kind, message.text);
        refresh();
        if (result.body.applied > 0) {
          void invalidateDocument("profiles");
        }
        return;
      }
      toast("error", result.kind === "error" ? (result.body?.error ?? "Apply failed") : "Apply failed");
    });
  };
  const dismiss = (id: string): void => {
    void api.dismissSuggestion(id).then((result) => {
      if (result.kind === "ok") {
        setSelected((current) => new Set([...current].filter((x) => x !== id)));
        toast("ok", "Dismissed");
        refresh();
      } else {
        toast("error", result.kind === "error" ? (result.body?.error ?? "Dismiss failed") : describeFailure(result, "Dismiss failed"));
      }
    });
  };
  const scan = (): void => {
    void api.scanSuggestions().then((result) => {
      if (result.kind === "ok") {
        toast("ok", "Scan complete");
        refresh();
      } else {
        toast("error", result.kind === "error" ? (result.body?.error ?? "Scan failed") : "Scan failed");
      }
    });
  };
  const toggleSelected = (id: string, checked: boolean): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const toolbar = (
    <div className="toolbar suggestion-toolbar">
      <Button disabled={applying} onClick={scan}>
        Scan now
      </Button>
      {applicable.length > 0 ? (
        <>
          <Checkbox
            aria-label="Select all"
            title="Select all"
            checked={allIds.length > 0 && allIds.every((id) => selected.has(id))}
            onChange={(checked) => {
              setSelected(checked ? new Set([...selected, ...allIds]) : new Set([...selected].filter((id) => !allIds.includes(id))));
            }}
          />
          <Button
            variant="primary"
            disabled={applying || selected.size === 0}
            onClick={() => {
              runApply([...selected], false);
            }}
          >
            Apply selected
          </Button>
          <Button
            variant="primary"
            disabled={applying}
            onClick={() => {
              runApply(undefined, true);
            }}
          >
            Apply all
          </Button>
        </>
      ) : null}
    </div>
  );
  const subtitle = loaded === null ? "Loading…" : `${filtered.length} shown · ${pendingCount(items)} pending · ${items.length} total`;

  const statusOptions = [{ value: ALL_VALUE, label: "All statuses" }, ...SUGGESTION_STATUSES.map((status) => ({ value: status, label: status }))];
  const kinds = [{ value: ALL_VALUE, label: "All kinds" }, ...kindOptions(items, catalog).map((kind) => ({ value: kind, label: kindLabel(kind) }))];
  const confidences = [{ value: ALL_VALUE, label: "All confidence" }, ...CONFIDENCE_VALUES.map((tier) => ({ value: tier, label: tier }))];

  return (
    <>
      <PageHead title="Suggestions" subtitle={subtitle} toolbar={toolbar} />
      {loaded === null ? null : (
        <div className="suggestion-filters" role="search">
          <FilterSelect label="Status" value={filters.status} options={statusOptions} onChange={(status) => { setFilters({ ...filters, status }); }} />
          <FilterSelect label="Kind" value={filters.kind} options={kinds} onChange={(kind) => { setFilters({ ...filters, kind }); }} />
          <FilterSelect label="Confidence" value={filters.confidence} options={confidences} onChange={(confidence) => { setFilters({ ...filters, confidence }); }} />
          {filtersActive(filters) ? (
            <Button
              onClick={() => {
                setFilters({ ...DEFAULT_FILTERS });
              }}
            >
              Clear filters
            </Button>
          ) : null}
        </div>
      )}
      {applying ? (
        <div className="notice" role="status">
          Applying…
        </div>
      ) : null}
      {loaded === null ? (
        query.error === null ? (
          <div className="memory-skeleton" aria-busy="true">
            <div className="skeleton-row" />
            <div className="skeleton-row" />
            <div className="skeleton-row" />
          </div>
        ) : (
          <div className="notice" role="alert">{query.error.message}</div>
        )
      ) : (
        <div className="suggestion-list" role="list">
          {items.length === 0 ? (
            <div className="empty" role="status">No suggestions yet. Finish a run or click Scan now.</div>
          ) : filtered.length === 0 ? (
            <div className="empty">No suggestions match the current filters.</div>
          ) : (
            sortSuggestions(filtered).map((item) => (
              <SuggestionCard
                key={item.id}
                item={item}
                selected={selected.has(item.id)}
                busy={applying}
                onSelect={(checked) => {
                  toggleSelected(item.id, checked);
                }}
                onApply={() => {
                  runApply([item.id], false);
                }}
                onDismiss={() => {
                  dismiss(item.id);
                }}
              />
            ))
          )}
        </div>
      )}
    </>
  );
}
