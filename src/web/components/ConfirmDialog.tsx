import "./overlays.css";
import { createContext, use, useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "./Button";

export interface ConfirmOptions {
  title: string;
  body: string;
  confirmLabel: string;
  danger: boolean;
}

type Confirm = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Confirm | null>(null);

interface Pending {
  options: ConfirmOptions;
  resolve: (confirmed: boolean) => void;
}

export function ConfirmDialog({
  options,
  onClose,
}: {
  options: ConfirmOptions;
  onClose: (confirmed: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const confirmed = useRef(false);
  useEffect(() => {
    const node = dialog.current;
    if (node !== null && !node.open) {
      node.showModal();
    }
  }, []);
  return (
    <dialog
      ref={dialog}
      className="confirm"
      aria-labelledby="confirm-title"
      onClose={() => {
        onClose(confirmed.current);
      }}
    >
      <h2 id="confirm-title">{options.title}</h2>
      <p>{options.body}</p>
      <div className="actions">
        <Button
          autoFocus
          onClick={() => {
            dialog.current?.close();
          }}
        >
          Cancel
        </Button>
        <Button
          variant={options.danger ? "danger" : "primary"}
          onClick={() => {
            confirmed.current = true;
            dialog.current?.close();
          }}
        >
          {options.confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}

/**
 * The replacement for the browser-native confirm popup: a modal <dialog> that names the target in
 * `title`, the consequence in `body`, and puts the destructive action in the danger colour. Cancel
 * is focused first and Escape cancels, so every exit settles the promise once.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const confirm = useCallback<Confirm>(
    (options) =>
      new Promise<boolean>((resolve) => {
        setPending({ options, resolve });
      }),
    [],
  );
  return (
    <ConfirmContext value={confirm}>
      {children}
      {pending === null ? null : (
        <ConfirmDialog
          options={pending.options}
          onClose={(confirmed) => {
            pending.resolve(confirmed);
            setPending(null);
          }}
        />
      )}
    </ConfirmContext>
  );
}

export function useConfirm(): Confirm {
  const confirm = use(ConfirmContext);
  if (confirm === null) {
    throw new Error("useConfirm needs a ConfirmProvider");
  }
  return confirm;
}
