import "./overlays.css";
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { TOAST_MS } from "../lib/constants";

export type ToastKind = "ok" | "error";
type PushToast = (kind: ToastKind, text: string) => void;

interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

const ToastContext = createContext<PushToast | null>(null);

function ToastNode({ item, onDone }: { item: ToastItem; onDone: (id: number) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onDone(item.id);
    }, TOAST_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [item.id, onDone]);
  return <div className={`toast ${item.kind}`}>{item.text}</div>;
}

/** Transient feedback for save outcomes, in the shell's `#toasts` live region (announced, no focus move). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(0);
  const push = useCallback<PushToast>((kind, text) => {
    next.current += 1;
    const id = next.current;
    setItems((current) => [...current, { id, kind, text }]);
  }, []);
  const drop = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);
  const stable = useMemo(() => push, [push]);
  return (
    <ToastContext value={stable}>
      {children}
      <div id="toasts" role="status" aria-live="polite">
        {items.map((item) => (
          <ToastNode key={item.id} item={item} onDone={drop} />
        ))}
      </div>
    </ToastContext>
  );
}

export function useToast(): PushToast {
  const push = use(ToastContext);
  if (push === null) {
    throw new Error("useToast needs a ToastProvider");
  }
  return push;
}
