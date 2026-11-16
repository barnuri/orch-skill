import { useEffect, useState } from "react";
import { draftScopes, DRAFT_EVENT } from "../lib/chat-draft";

/** Projects (and `none`) that hold an unsent first message. Re-read on every draft write, and when another tab writes. */
export function useDraftScopes(): string[] {
  const [scopes, setScopes] = useState<string[]>(() => draftScopes());
  useEffect(() => {
    const read = (): void => {
      setScopes((now) => {
        const next = draftScopes();
        return next.length === now.length && next.every((s, i) => s === now[i]) ? now : next;
      });
    };
    window.addEventListener(DRAFT_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(DRAFT_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return scopes;
}
