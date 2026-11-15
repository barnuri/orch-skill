import { useCallback, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

const memory = new Map<string, unknown>();

/**
 * useState whose value survives leaving and re-entering a page (kept in memory for the tab's life).
 * The store is written when `set` is called, not inside a state updater: React runs updaters at
 * render time, so a component that unmounts in the same batch would never persist its last value.
 */
export function useSessionState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => (memory.has(key) ? (memory.get(key) as T) : initial));
  const latest = useRef<T>(value);
  latest.current = value;
  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (next) => {
      const current = memory.has(key) ? (memory.get(key) as T) : latest.current;
      const resolved = typeof next === "function" ? (next as (prev: T) => T)(current) : next;
      memory.set(key, resolved);
      latest.current = resolved;
      setValue(resolved);
    },
    [key],
  );
  return [value, set];
}

export function clearSessionState(): void {
  memory.clear();
}
