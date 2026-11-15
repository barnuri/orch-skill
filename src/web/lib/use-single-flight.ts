import { useCallback, useRef, useState } from "react";

/**
 * Wraps an async action so a second call while the first is in flight is ignored (a double click on
 * "New chat" must not create two chats). The ref guards calls that land before React re-renders the
 * disabled button; `busy` is for that `disabled`.
 */
export function useSingleFlight<A extends unknown[]>(action: (...args: A) => Promise<void>): [(...args: A) => Promise<void>, boolean] {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const latest = useRef(action);
  latest.current = action;
  const run = useCallback(async (...args: A): Promise<void> => {
    if (running.current) {
      return;
    }
    running.current = true;
    setBusy(true);
    try {
      await latest.current(...args);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);
  return [run, busy];
}
