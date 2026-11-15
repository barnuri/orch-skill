import { useCallback, useEffect, useRef, useState } from "react";
import { DOCUMENT_KINDS } from "../../shared/types/document-kind";
import type { DocumentKind } from "../../shared/types/document-kind";
import type { Issue } from "../../shared/types/issue";
import { useToast } from "../components/Toast";
import { api } from "../api/client";
import { invalidateDocument } from "../api/queries";
import type { LoadedDocument } from "../api/queries";

/** null = nothing open, "new" = an unsaved entry, string = a profile name, number = a memory index. */
export type EditingTarget = null | "new" | string | number;

const HTTP_BAD_REQUEST = 400;
const HTTP_PRECONDITION_FAILED = 412;
const NETWORK_SAVE_ERROR = "cannot reach the server — nothing was saved";
const STALE_SAVED = "Changed on disk by another session — reloaded, redo your edit";

export function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export interface DocEditor {
  /** The document the page and its forms are drawn from. Frozen while the user has unsaved edits. */
  base: LoadedDocument | null;
  target: EditingTarget;
  dirty: boolean;
  /** The file changed on disk while the form was dirty: the form is kept, a banner offers a reload. */
  drift: boolean;
  /** Bumps whenever forms must reseed from `base` (new target, adopted reload, saved). Use as a React key. */
  session: number;
  fieldIssues: readonly Issue[];
  docError: string | null;
  saving: boolean;
  begin: (target: EditingTarget) => void;
  cancel: () => void;
  markDirty: () => void;
  setFieldIssues: (issues: readonly Issue[]) => void;
  /** PUTs the whole document with If-Match. Resolves true when saved. */
  save: (next: unknown) => Promise<boolean>;
}

/**
 * The edit session of one JSON document. Render discipline carried over from the vanilla page: a
 * poll that brings a new ETag while the form is dirty never rebuilds the form (drift is flagged
 * instead); while clean, the new document is adopted at once.
 */
export function useDocEditor(kind: DocumentKind, loaded: LoadedDocument | undefined): DocEditor {
  const toast = useToast();
  const [base, setBase] = useState<LoadedDocument | null>(null);
  const [target, setTarget] = useState<EditingTarget>(null);
  const [dirty, setDirty] = useState(false);
  const [drift, setDrift] = useState(false);
  const [session, setSession] = useState(0);
  const [fieldIssues, setFieldIssues] = useState<readonly Issue[]>([]);
  const [docError, setDocError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  useEffect(() => {
    if (loaded === undefined) {
      return;
    }
    if (base === null) {
      setBase(loaded);
    } else if (loaded.etag !== base.etag) {
      if (dirty) {
        setDrift(true);
      } else {
        setBase(loaded);
        setSession((n) => n + 1);
      }
    }
  }, [loaded, base, dirty]);

  const clear = useCallback(() => {
    setTarget(null);
    setDirty(false);
    setDrift(false);
    setFieldIssues([]);
    setDocError(null);
    setSession((n) => n + 1);
  }, []);

  const begin = useCallback(
    (next: EditingTarget) => {
      if (base === null || base.document === null || next === target) {
        return;
      }
      setFieldIssues([]);
      setDocError(null);
      setDirty(false);
      setDrift(false);
      setTarget(next);
      setSession((n) => n + 1);
    },
    [base, target],
  );

  const cancel = useCallback(() => {
    const drifted = drift;
    clear();
    if (drifted && loaded !== undefined) {
      setBase(loaded);
    }
  }, [clear, drift, loaded]);

  const save = useCallback(
    async (next: unknown): Promise<boolean> => {
      if (savingRef.current || base === null) {
        return false;
      }
      setDocError(null);
      setFieldIssues([]);
      const bytes = byteLength(next);
      if (bytes > base.limits.max_body_bytes) {
        setDocError(`document is ${bytes} bytes; the server accepts at most ${base.limits.max_body_bytes}`);
        return false;
      }
      savingRef.current = true;
      setSaving(true);
      try {
        const result = await api.putDocument(kind, next, base.etag);
        if (result.kind === "ok") {
          clear();
          toast("ok", `Saved ${DOCUMENT_KINDS[kind]}`);
          await invalidateDocument(kind);
          return true;
        }
        if (result.kind === "network") {
          toast("error", NETWORK_SAVE_ERROR);
        } else if (result.kind === "error" && result.status === HTTP_BAD_REQUEST) {
          setFieldIssues(result.body?.issues ?? []);
          setDocError(result.body?.error ?? `HTTP ${result.status}`);
        } else if (result.kind === "error" && result.status === HTTP_PRECONDITION_FAILED) {
          toast("error", STALE_SAVED);
          clear();
          await invalidateDocument(kind);
        } else if (result.kind === "error") {
          // 401 raises the token gate; the draft stays, so the form comes back intact after the token.
          if (result.status !== 401) {
            toast("error", result.body?.error ?? `HTTP ${result.status}`);
          }
        } else if (result.kind === "invalid") {
          toast("error", result.message);
        } else {
          toast("error", "unexpected 304 on save");
        }
        return false;
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [base, clear, kind, toast],
  );

  return {
    base,
    target,
    dirty,
    drift,
    session,
    fieldIssues,
    docError,
    saving,
    begin,
    cancel,
    markDirty: useCallback(() => {
      setDirty(true);
    }, []),
    setFieldIssues,
    save,
  };
}

/** Escape closes an open editor, unless the draft is dirty: discarding typed changes is not recoverable. */
export function useEscapeToClose(editor: Pick<DocEditor, "target" | "dirty" | "cancel">): void {
  const { target, dirty, cancel } = editor;
  useEffect(() => {
    if (target === null || dirty) {
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [target, dirty, cancel]);
}
