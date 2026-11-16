import { useEffect, useId, useState } from "react";

import { normaliseSubfolder, SubfolderError } from "../../shared/subfolder";
import { useSubfolderSuggestions } from "./queries";

/** A server answer reads `subfolder: reason`; the field already says Subfolder, so show the reason as a sentence. */
function sentence(text: string): string {
  const reason = text.replace(/^subfolder:\s*/, "");
  return reason.charAt(0).toUpperCase() + reason.slice(1) + (reason.endsWith(".") ? "" : ".");
}

/**
 * The subfolder of a project's folder a chat runs in. Saves on blur or Enter, Clear removes it. `onSave` gets the normalised
 * value (null clears) and returns the server's error text or null. The caller shows this only when the project has a folder.
 */
export function SubfolderField({ projectPath, value, onSave }: {
  projectPath: string;
  value: string | null;
  onSave: (next: string | null) => Promise<string | null>;
}) {
  const [draft, setDraft] = useState(value ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const suggestions = useSubfolderSuggestions(projectPath);
  useEffect(() => {
    setDraft(value ?? "");
    setError(null);
  }, [value]);

  const commit = async (text: string): Promise<void> => {
    let next: string | null;
    try {
      next = normaliseSubfolder(text);
    } catch (err) {
      setError(err instanceof SubfolderError ? sentence(err.message) : "This is not a valid subfolder.");
      return;
    }
    if (next === value) {
      setError(null);
      setDraft(next ?? "");
      return;
    }
    setBusy(true);
    const problem = await onSave(next);
    setBusy(false);
    setError(problem === null ? null : sentence(problem));
    if (problem === null) {
      setDraft(next ?? "");
    }
  };

  const shown = normaliseSafe(draft);
  return (
    <div className="field-group subfolder-field" data-testid="subfolder-field">
      <label className="field-label" htmlFor={id}>Subfolder</label>
      <div className="subfolder-row">
        <input
          id={id} className="input subfolder-input mono" dir="ltr" list={`${id}-list`} value={draft} disabled={busy}
          placeholder="Optional, inside the project folder" autoComplete="off" spellCheck={false}
          aria-invalid={error !== null} aria-describedby={`${id}-path ${id}-error`}
          onChange={(e) => { setDraft(e.target.value); setError(null); }}
          onBlur={() => void commit(draft)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void commit(draft); } }}
        />
        <datalist id={`${id}-list`}>
          {(suggestions.data ?? []).map((name) => <option key={name} value={name} />)}
        </datalist>
        {value === null && draft === "" ? null : (
          <button type="button" className="btn subfolder-clear" disabled={busy} onMouseDown={(e) => { e.preventDefault(); }} onClick={() => { setDraft(""); void commit(""); }}>Clear</button>
        )}
      </div>
      <span id={`${id}-path`} className="subfolder-path mono" dir="ltr" data-testid="subfolder-path">{shown === null ? projectPath : `${projectPath}/${shown}`}</span>
      <span id={`${id}-error`} className="subfolder-error" role={error === null ? undefined : "alert"} data-testid="subfolder-error">{error}</span>
    </div>
  );
}

function normaliseSafe(text: string): string | null {
  try {
    return normaliseSubfolder(text);
  } catch {
    return null;
  }
}
