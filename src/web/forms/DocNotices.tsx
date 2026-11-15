import { DOCUMENT_KINDS } from "../../shared/types/document-kind";
import type { DocumentKind } from "../../shared/types/document-kind";
import { Button } from "../components/Button";
import { useConfirm } from "../components/ConfirmDialog";
import type { DocEditor, EditingTarget } from "./use-doc-editor";

function editingLabel(kind: DocumentKind, editing: EditingTarget): string {
  if (editing === "new") {
    return kind === "profiles" ? "the new profile" : "the new entry";
  }
  if (typeof editing === "number") {
    return `entry #${editing}`;
  }
  return editing === null ? "this form" : `profile "${editing}"`;
}

/**
 * The notice block above a document view: drift (the file changed while the form is dirty), the
 * last save error, and the problems the server found in the file as it is on disk. The PUT validator
 * checks the whole document, so nothing can be saved from the dashboard until those are fixed.
 */
export function DocNotices({ kind, editor }: { kind: DocumentKind; editor: DocEditor }) {
  const confirm = useConfirm();
  const issues = editor.base?.issues ?? [];
  const file = DOCUMENT_KINDS[kind];
  if (editor.base === null) {
    return <div id="doc-notices" />;
  }
  return (
    <div id="doc-notices">
      {editor.drift ? (
        <div className="notice warn">
          {`${file} changed on disk`}
          <Button
            onClick={() => {
              void confirm({
                title: `Reload ${file}?`,
                body: `Discards your unsaved edits to ${editingLabel(kind, editor.target)} and shows what is now on disk.`,
                confirmLabel: "Reload",
                danger: true,
              }).then((confirmed) => {
                if (confirmed) {
                  editor.cancel();
                }
              });
            }}
          >
            Reload (discards your edits)
          </Button>
        </div>
      ) : null}
      {editor.docError === null ? null : (
        <div className="notice" role="alert">
          {editor.docError}
        </div>
      )}
      {issues.length === 0 ? null : (
        <div className="notice">
          <p>{`${file} has ${issues.length} ${issues.length === 1 ? "problem" : "problems"}; fix them to save from here.`}</p>
          <ul className="mono">
            {issues.map((issue) => (
              <li key={`${issue.path}:${issue.reason}`}>{`${issue.path}: ${issue.reason}`}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
