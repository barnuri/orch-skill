import { summarizeError } from "../../shared/chat-activity";
import { CopyButton } from "./CopyButton";

interface Props {
  /** The raw error text the server stored. */
  error: string | null;
  onRetry?: (() => void) | undefined;
}

/** A failed reply: what happened in one line, the fix in one sentence, the raw error on demand. The only place the thread turns red. */
export function ErrorNotice({ error, onRetry }: Props) {
  const { title, fix } = summarizeError(error);
  const raw = (error ?? "").trim() === "" ? "No details were reported." : (error as string);
  return (
    <div className="error-notice" role="alert" data-testid="error-notice">
      <svg className="error-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7.5v5.5M12 16.5v.01" />
      </svg>
      <div className="error-body">
        <p className="error-title">{title}</p>
        <p className="error-fix">{fix}</p>
        <details className="error-raw">
          <summary>Show the raw error</summary>
          <pre className="mono">{raw}</pre>
        </details>
      </div>
      <div className="error-actions">
        {onRetry !== undefined ? <button type="button" className="btn" data-testid="error-retry" onClick={onRetry}>Retry</button> : null}
        <CopyButton text={`${title}\n${raw}`} label="Copy details" className="btn" />
      </div>
    </div>
  );
}
