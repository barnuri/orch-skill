import { useEffect } from "react";
import { getToken } from "../api/token";
import { authHeaders, chatIdOfHash } from "./app";

const BEAT_MS = 2000;

/**
 * While a chat is on screen and the window has focus, tell the server every 2 s: it then sends no notification for
 * that chat (it waits 3 s after the last beat). Leaving, hiding or blurring reports it right away.
 */
export function usePresence(): void {
  useEffect(() => {
    let prev: string | null = null;
    const post = (chat: string, visible: boolean, focused: boolean): void => {
      void fetch("/api/push/presence", {
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json", ...authHeaders(getToken()) },
        body: JSON.stringify({ chat_id: chat, visible, focused }),
      }).catch(() => {});
    };
    const send = (): void => {
      const chat = chatIdOfHash(location.hash);
      if (prev !== null && prev !== chat) post(prev, false, false);
      prev = chat;
      if (chat !== null) post(chat, document.visibilityState === "visible", document.hasFocus());
    };
    const timer = setInterval(send, BEAT_MS);
    for (const ev of ["visibilitychange", "focus", "blur", "hashchange", "pagehide"]) window.addEventListener(ev, send);
    document.addEventListener("visibilitychange", send);
    send();
    return () => {
      clearInterval(timer);
      for (const ev of ["visibilitychange", "focus", "blur", "hashchange", "pagehide"]) window.removeEventListener(ev, send);
      document.removeEventListener("visibilitychange", send);
    };
  }, []);
}
