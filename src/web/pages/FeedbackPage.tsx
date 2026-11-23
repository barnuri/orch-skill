import "./pages-b.css";
import "./feedback.css";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { FEEDBACK_STATUSES, type FeedbackItem, type FeedbackKind } from "../../shared/types/feedback";
import { feedbackApi } from "../api/feedback-client";
import { describeFailure } from "../api/result";
import { POLL_MS } from "../lib/constants";
import { Button } from "../components/Button";
import { Checkbox } from "../components/Checkbox";
import { Chip } from "../components/Chip";
import { EmptyState } from "../components/EmptyState";
import { PageHead } from "../components/PageHead";
import { Segmented } from "../components/Segmented";
import { Select } from "../components/Select";
import { Skeleton } from "../components/Skeleton";
import { useToast } from "../components/Toast";
import { useRuns } from "../runs/queries";
import { useSessionState } from "../lib/session-state";
import {
  actionsFor,
  ALL_STATUSES,
  filterByStatus,
  kindOptions,
  linkFor,
  newIds,
  pruneSelection,
  sortNewestFirst,
  workRunStatus,
  workSummary,
} from "../lib/feedback-logic";
import type { StatusFilter } from "../lib/feedback-logic";

const FEEDBACK_KEY = ["feedback"];

/** One ledger row: status, the text with its metadata line, and the row actions. The metadata line holds the id, source, kind, link, work run and result. */
function FeedbackRow({
  item,
  runStatus,
  selected,
  busy,
  onSelect,
  onAction,
}: {
  item: FeedbackItem;
  runStatus: string | null;
  selected: boolean;
  busy: boolean;
  onSelect: (checked: boolean) => void;
  onAction: (status: FeedbackItem["status"]) => void;
}) {
  const link = linkFor(item);
  return (
    <tr className={`feedback-row status-${item.status}`}>
      <td>
        <Checkbox aria-label={`Select ${item.id}`} checked={selected} onChange={onSelect} />
      </td>
      <td>
        <Chip status={item.status} />
      </td>
      <td>
        <span className="feedback-text">{item.text}</span>
        <span className="feedback-meta">
          <span className="feedback-mono">{item.id}</span>
          <span>{item.source}</span>
          <span>{item.kind}</span>
          {link === null ? null : (
            <a className="text-link feedback-mono" href={link.href}>
              {link.label}
            </a>
          )}
          {item.work_run === undefined ? null : (
            <span className="feedback-run">
              <a className="text-link feedback-mono" href={`#/run/${encodeURIComponent(item.work_run)}`}>
                {item.work_run}
              </a>
              <Chip status={runStatus ?? "unknown"} />
            </span>
          )}
          {item.result === undefined ? null : <span className="feedback-result">{item.result}</span>}
        </span>
      </td>
      <td>
        <div className="feedback-actions">
          {actionsFor(item.status).map((a) => (
            <Button key={a.action} disabled={busy} onClick={() => onAction(a.target)}>
              {a.label}
            </Button>
          ))}
        </div>
      </td>
    </tr>
  );
}

/** The `#/feedback` page: a composer, a status filter, a compact ledger with row actions, and work on new or selected items. */
export function FeedbackPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const runs = useRuns();
  const query = useQuery({
    queryKey: FEEDBACK_KEY,
    queryFn: async () => {
      const result = await feedbackApi.list();
      if (result.kind !== "ok") {
        throw new Error(describeFailure(result, "Feedback could not be loaded"));
      }
      return result.body;
    },
    refetchInterval: POLL_MS,
  });
  const [status, setStatus] = useSessionState<StatusFilter>("feedback-status", ALL_STATUSES);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<FeedbackKind>("other");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const items = useMemo(() => sortNewestFirst(query.data?.items ?? []), [query.data]);
  const visible = filterByStatus(items, status);
  const runStatus = useMemo(() => new Map((runs.data?.runs ?? []).map((r) => [r.run_id, r.status] as const)), [runs.data]);
  const newCount = newIds(items).length;
  const filterOptions = [
    { value: ALL_STATUSES, label: `all ${items.length}` },
    ...FEEDBACK_STATUSES.map((s) => ({ value: s, label: `${s} ${items.filter((item) => item.status === s).length}` })),
  ];

  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: FEEDBACK_KEY }).then(() => undefined);
  const run = (task: () => Promise<void>): void => {
    if (busy) {
      return;
    }
    setBusy(true);
    void task().finally(() => {
      setBusy(false);
    });
  };

  const add = (): void => {
    const trimmed = text.trim();
    if (trimmed === "") {
      toast("error", "Write the feedback first");
      return;
    }
    run(async () => {
      const result = await feedbackApi.create(trimmed, kind);
      if (result.kind !== "ok") {
        toast("error", describeFailure(result, "Request failed"));
        return;
      }
      setText("");
      toast("ok", `Added ${result.body.item.id}`);
      await refresh();
    });
  };

  const setItemStatus = (id: string, next: FeedbackItem["status"]): void => {
    run(async () => {
      const result = await feedbackApi.setStatus(id, next);
      if (result.kind !== "ok") {
        toast("error", describeFailure(result, "Request failed"));
        return;
      }
      toast("ok", `${id} is ${next}`);
      await refresh();
    });
  };

  const work = (ids: readonly string[] | undefined): void => {
    run(async () => {
      const result = await feedbackApi.work(ids);
      if (result.kind !== "ok") {
        toast("error", describeFailure(result, "Request failed"));
        return;
      }
      toast("ok", workSummary(result.body.items.length, result.body.run_id));
      setSelected(new Set());
      await refresh();
    });
  };

  const toggle = (id: string, checked: boolean): void => {
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

  const selectedIds = [...pruneSelection(selected, items)];
  const loadFailed = query.isError && items.length === 0;

  const body = (() => {
    if (query.isPending) {
      return (
        <div className="feedback-loading" role="status" aria-live="polite">
          <span>Loading feedback…</span>
          <Skeleton rows={4} />
        </div>
      );
    }
    if (loadFailed) {
      return null;
    }
    if (items.length === 0) {
      return (
        <EmptyState title="No feedback yet" action={<Button onClick={() => document.getElementById("feedback-text")?.focus()}>Write feedback</Button>}>
          Write the first item above. It starts as new and waits for a batch run.
        </EmptyState>
      );
    }
    if (visible.length === 0) {
      return (
        <EmptyState title="No feedback with this status" action={<Button onClick={() => setStatus(ALL_STATUSES)}>Show all statuses</Button>}>
          Nothing has the status {status} yet. Show all statuses to see the {items.length} items.
        </EmptyState>
      );
    }
    return (
      <div className="feedback-list">
        <table className="feedback-table">
          <thead>
            <tr>
              <th scope="col" className="sr-only">
                Select
              </th>
              <th scope="col">Status</th>
              <th scope="col">Feedback</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((item) => (
              <FeedbackRow
                key={item.id}
                item={item}
                runStatus={workRunStatus(item, runStatus)}
                selected={selected.has(item.id)}
                busy={busy}
                onSelect={(checked) => toggle(item.id, checked)}
                onAction={(next) => setItemStatus(item.id, next)}
              />
            ))}
          </tbody>
        </table>
      </div>
    );
  })();

  return (
    <section className="page feedback-page">
      <PageHead
        title="Feedback"
        subtitle="Feedback on orch, its chat and its code. Work on new items starts one batch run."
        toolbar={
          <>
            <Button variant="primary" disabled={busy || newCount === 0} onClick={() => work(undefined)}>
              Work on all new feedback ({newCount})
            </Button>
            <Button disabled={busy || selectedIds.length === 0} onClick={() => work(selectedIds)}>
              Work on selected ({selectedIds.length})
            </Button>
          </>
        }
      />

      <form
        className="feedback-composer"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <label className="feedback-field feedback-field-text">
          <span className="feedback-label">New feedback</span>
          <textarea id="feedback-text" className="feedback-input" value={text} onChange={(event) => setText(event.target.value)} rows={1} />
        </label>
        <div className="feedback-composer-side">
          <div className="feedback-field">
            <span className="feedback-label">Kind</span>
            <Select aria-label="Kind" value={kind} options={kindOptions()} onChange={(next) => setKind(next as FeedbackKind)} />
          </div>
          <Button variant="primary" type="submit" disabled={busy}>
            Add feedback
          </Button>
        </div>
      </form>

      <div className="feedback-bar">
        <div className="feedback-filter">
          <Segmented label="Filter by status" value={status} options={filterOptions} onChange={(next) => setStatus(next as StatusFilter)} />
        </div>
        <span className="feedback-count" aria-live="polite">
          {items.length === 0 ? "0 items" : `${visible.length} of ${items.length} items · ${newCount} new`}
        </span>
      </div>

      {query.isError ? (
        <div className="feedback-error" role="alert">
          <span>
            <strong>Load failed.</strong> Feedback could not be loaded: {(query.error as Error).message}
          </span>
          <Button onClick={() => void query.refetch()}>Retry</Button>
        </div>
      ) : null}

      {body}
    </section>
  );
}
