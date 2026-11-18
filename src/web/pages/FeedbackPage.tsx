import "./pages-b.css";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { FeedbackItem, FeedbackKind } from "../../shared/types/feedback";
import { feedbackApi } from "../api/feedback-client";
import { describeFailure } from "../api/result";
import { POLL_MS } from "../lib/constants";
import { Button } from "../components/Button";
import { Checkbox } from "../components/Checkbox";
import { Chip } from "../components/Chip";
import { PageHead } from "../components/PageHead";
import { Select } from "../components/Select";
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
  statusOptions,
  workRunStatus,
  workSummary,
} from "../lib/feedback-logic";
import type { StatusFilter } from "../lib/feedback-logic";

const FEEDBACK_KEY = ["feedback"];

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
        <Chip status={item.kind} />
      </td>
      <td>{item.source}</td>
      <td>
        <span className="feedback-text">{item.text}</span>
        <span className="muted"> {item.id}</span>
      </td>
      <td>{link === null ? <span className="muted">none</span> : <a className="text-link" href={link.href}>{link.label}</a>}</td>
      <td>
        {item.work_run === undefined ? (
          <span className="muted">none</span>
        ) : (
          <>
            <a className="text-link" href={`#/run/${encodeURIComponent(item.work_run)}`}>{item.work_run}</a>{" "}
            <Chip status={runStatus ?? "unknown"} />
          </>
        )}
      </td>
      <td>{item.result ?? <span className="muted">none</span>}</td>
      <td>
        <div className="actions">
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

/** The `#/feedback` page: feedback items for orch, with a form, status filters, row actions and work on new or selected items. */
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
        className="feedback-form"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <label className="filter-field">
          <span className="filter-label">Feedback</span>
          <textarea value={text} onChange={(event) => setText(event.target.value)} rows={2} />
        </label>
        <div className="filter-field">
          <span className="filter-label">Kind</span>
          <Select aria-label="Kind" value={kind} options={kindOptions()} onChange={(next) => setKind(next as FeedbackKind)} />
        </div>
        <Button variant="primary" type="submit" disabled={busy}>
          Add feedback
        </Button>
      </form>

      <div className="filters">
        <div className="filter-field">
          <span className="filter-label">Status</span>
          <Select aria-label="Status" value={status} options={statusOptions()} onChange={(next) => setStatus(next as StatusFilter)} />
        </div>
      </div>

      {query.isError ? <p className="error">Feedback could not be loaded: {(query.error as Error).message}</p> : null}
      {visible.length === 0 && !query.isError ? <p className="muted">No feedback{status === ALL_STATUSES ? "" : ` with status ${status}`}.</p> : null}

      {visible.length === 0 ? null : (
        <table className="feedback-table">
          <thead>
            <tr>
              <th scope="col">Select</th>
              <th scope="col">Status</th>
              <th scope="col">Kind</th>
              <th scope="col">Source</th>
              <th scope="col">Feedback</th>
              <th scope="col">Linked</th>
              <th scope="col">Work run</th>
              <th scope="col">Result</th>
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
      )}
    </section>
  );
}
