import { createContext, use, useId, useMemo } from "react";
import type { ReactNode } from "react";
import type { Issue } from "../../shared/types/issue";
import { matchIssues } from "../lib/issue-match";
import type { MatchedIssues } from "../lib/issue-match";

const EMPTY: MatchedIssues = { byPath: new Map(), unmatched: [] };

const IssuesContext = createContext<MatchedIssues>(EMPTY);

/** Matches `issues` against the form's field paths; `unmatched` is for the caller to list above the form. */
export function useMatchedIssues(paths: readonly string[], issues: readonly Issue[]): MatchedIssues {
  const key = paths.join("\n");
  return useMemo(() => matchIssues(paths, issues), [key, issues]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function IssuesProvider({ value, children }: { value: MatchedIssues; children: ReactNode }) {
  return <IssuesContext value={value}>{children}</IssuesContext>;
}

interface FieldProps {
  label: string;
  /** Document path the server reports issues against (`profiles.<n>.flags`, `memory[3].outcome`, ...). */
  path: string;
  hint?: string;
  check?: boolean;
  children: (control: { id: string; invalid: boolean }) => ReactNode;
}

/** `.field` row: label wired to the control by id, with the hint and any issues pinned to `path`. */
export function Field({ label, path, hint, children }: FieldProps) {
  const id = useId();
  const errors = use(IssuesContext).byPath.get(path) ?? [];
  return (
    <div className="field" data-path={path}>
      <label htmlFor={id}>{label}</label>
      {children({ id, invalid: errors.length > 0 })}
      {hint === undefined ? null : <div className="hint">{hint}</div>}
      {errors.map((message) => (
        <div key={message} className="field-error">
          {message}
        </div>
      ))}
    </div>
  );
}

/** Unmatched-issue list shown above a form. */
export function IssueList({ issues }: { issues: readonly Issue[] }) {
  if (issues.length === 0) {
    return null;
  }
  return (
    <div className="notice" role="alert">
      <ul className="mono">
        {issues.map((issue) => (
          <li key={`${issue.path}:${issue.reason}`}>{`${issue.path}: ${issue.reason}`}</li>
        ))}
      </ul>
    </div>
  );
}

/** Errors under a non-labelled field (a check list), keyed like Field. */
export function useFieldErrors(path: string): readonly string[] {
  return use(IssuesContext).byPath.get(path) ?? [];
}

export function FieldErrors({ path }: { path: string }) {
  const errors = useFieldErrors(path);
  return (
    <>
      {errors.map((message) => (
        <div key={message} className="field-error">
          {message}
        </div>
      ))}
    </>
  );
}
