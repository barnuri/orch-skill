import { useEffect, useState } from "react";
import { chatsApi } from "../api/chats";
import { useToast } from "../components/Toast";
import { isSearchShortcut, keyboardInset, normalizeSelection } from "../lib/chat-logic";
import { ChatView } from "./ChatView";
import { ProjectView } from "./ProjectView";
import { Sidebar } from "./Sidebar";
import { refreshChats, useChatOptions, useChats } from "./queries";
import { useSingleFlight } from "../lib/use-single-flight";

interface Props {
  chatId: string | null;
  projectId: string | null;
}

/** When the sidebar is a drawer; mirrors the phone media query in chats.css (a landscape phone is wide but short). */
export const DRAWER_QUERY: string = "(max-width: 768px), (max-height: 500px) and (pointer: coarse)";

/** Desktop: sidebar + conversation. Phone: the conversation alone, with the sidebar as a slide-over drawer. */
export function ChatsPage({ chatId, projectId }: Props) {
  const [drawer, setDrawer] = useState(false);
  const options = useChatOptions();
  const chats = useChats(false);
  const toast = useToast();

  useEffect(() => {
    document.body.classList.add("chats-page");
    return () => {
      document.body.classList.remove("chats-page");
    };
  }, []);
  useEffect(() => {
    const header = document.querySelector("header");
    if (header === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const set = (): void => {
      document.documentElement.style.setProperty("--hdr", `${header.getBoundingClientRect().height}px`);
    };
    set();
    const watcher = new ResizeObserver(set);
    watcher.observe(header);
    return () => {
      watcher.disconnect();
      document.documentElement.style.removeProperty("--hdr");
    };
  }, []);
  useEffect(() => {
    const vv = window.visualViewport;
    if (vv === null || vv === undefined) {
      return;
    }
    const set = (): void => {
      document.documentElement.style.setProperty("--kb", `${keyboardInset(window.innerHeight, vv)}px`);
    };
    set();
    vv.addEventListener("resize", set);
    vv.addEventListener("scroll", set);
    return () => {
      vv.removeEventListener("resize", set);
      vv.removeEventListener("scroll", set);
      document.documentElement.style.removeProperty("--kb");
    };
  }, []);
  useEffect(() => {
    document.body.classList.toggle("drawer-open", drawer);
    return () => {
      document.body.classList.remove("drawer-open");
    };
  }, [drawer]);
  useEffect(() => {
    if (!drawer) {
      return;
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        setDrawer(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [drawer]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isSearchShortcut(e)) {
        return;
      }
      e.preventDefault();
      if (window.matchMedia(DRAWER_QUERY).matches) {
        setDrawer(true);
      }
      setTimeout(() => {
        const box = document.getElementById("chat-search");
        box?.focus();
        if (box instanceof HTMLInputElement) {
          box.select();
        }
      }, 0);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const open = (): void => { setDrawer(true); };
  const close = (): void => { setDrawer(false); };
  const [startChat, starting] = useSingleFlight(async (): Promise<void> => {
    // Never blocked: the first enabled harness is the default, and a chat with none is still created (the composer says why).
    const sel = options.data === undefined ? { harness: "", profile: "", model: null } : normalizeSelection(options.data, null);
    const res = await chatsApi.createChat({ project_id: null, harness: sel.harness, profile: sel.profile, model_id: sel.model });
    if (res.kind === "ok") {
      void refreshChats();
      location.hash = `#/chats/${encodeURIComponent(res.body.id)}`;
    } else {
      toast("error", "could not create the chat");
    }
  });

  return (
    <div className="chats-layout" data-drawer={drawer || undefined}>
      <aside className="chats-side" aria-label="Projects and chats">
        <button type="button" className="icon-btn side-close" aria-label="Close" onClick={close}>×</button>
        <Sidebar activeChatId={chatId} activeProjectId={projectId} options={options.data} onNavigate={close} />
      </aside>
      {drawer ? <div className="scrim" onClick={close} aria-hidden="true" /> : null}
      <section className="chats-main">
        {chatId !== null ? (
          <ChatView key={chatId} chatId={chatId} onOpenDrawer={open} />
        ) : projectId !== null ? (
          <ProjectView key={projectId} projectId={projectId} onOpenDrawer={open} />
        ) : (
          <div className="chat-empty">
            <button type="button" className="icon-btn drawer-btn" aria-label="Projects and chats" onClick={open}>☰</button>
            <h1>Chats</h1>
            <p className="muted">{chats.chats.length === 0 ? "No chats yet. Everything you send is saved here." : "Pick a chat on the left, or start a new one."}</p>
            <button type="button" className="btn primary" disabled={starting} onClick={() => void startChat()}>New chat</button>
          </div>
        )}
      </section>
    </div>
  );
}
