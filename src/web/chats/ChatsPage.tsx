import { useWaitingTitle } from "./question-hooks";
import { useCallback, useEffect, useState } from "react";
import { getToken } from "../api/token";
import { useChatFrame } from "./chat-frame";
import { chatOnlyUrl } from "./chat-only-link";
import { useToast } from "../components/Toast";
import { isSearchShortcut, keyboardInset, keyboardOpen } from "../lib/chat-logic";
import { chatIsWaiting } from "../lib/chat-waiting";
import { useRoute } from "../router/use-route";
import { ChatView } from "./ChatView";
import { ProjectView } from "./ProjectView";
import { Sidebar } from "./Sidebar";
import { SIDE_PANEL_ID, SideFloat, SideHead, SideRail, useSidebarMode } from "./SidebarChrome";
import { StartPage } from "./StartPage";
import { useChatOptions, useChats } from "./queries";

interface Props {
  chatId: string | null;
  projectId: string | null;
}

/** When the sidebar is a drawer; mirrors the phone media query in chats.css (a landscape phone is wide but short). */
export const DRAWER_QUERY: string = "(max-width: 768px), (max-height: 500px) and (pointer: coarse)";

/** Desktop: sidebar + conversation. Phone: the conversation alone, with the sidebar as a slide-over drawer. */
export function ChatsPage({ chatId, projectId }: Props) {
  const { standalone } = useChatFrame();
  useWaitingTitle();
  const [drawer, setDrawer] = useState(false);
  const options = useChatOptions();
  const chats = useChats(false);
  const toast = useToast();
  const route = useRoute();
  const draftRoute = route.kind === "chats" && route.draft === true ? route : null;
  const toggleDrawer = useCallback((): void => { setDrawer((d) => !d); }, []);
  const side = useSidebarMode(toggleDrawer);

  useEffect(() => {
    document.body.classList.add("chats-page");
    return () => {
      document.body.classList.remove("chats-page");
    };
  }, []);
  useEffect(() => {
    const vv = window.visualViewport;
    if (vv === null || vv === undefined) {
      return;
    }
    const set = (): void => {
      const inset = keyboardInset(window.innerHeight, vv);
      document.documentElement.style.setProperty("--kb", `${inset}px`);
      document.documentElement.toggleAttribute("data-kb", keyboardOpen(inset));
    };
    set();
    vv.addEventListener("resize", set);
    vv.addEventListener("scroll", set);
    return () => {
      vv.removeEventListener("resize", set);
      vv.removeEventListener("scroll", set);
      document.documentElement.style.removeProperty("--kb");
      document.documentElement.removeAttribute("data-kb");
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
      } else if (side.wide && side.mode !== "open") {
        side.change("open");
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
  }, [side.wide, side.mode, side.change]);

  const open = (): void => { setDrawer(true); };
  const close = (): void => { setDrawer(false); };
  const collapsed = side.wide && side.mode !== "open";
  return (
    <div className="chats-layout" data-drawer={drawer || undefined} data-side={side.wide ? side.mode : "open"}>
      <aside id={SIDE_PANEL_ID} className="chats-side" aria-label="Projects and chats">
        {side.wide && side.mode === "rail" ? <SideRail waiting={chats.chats.some(chatIsWaiting)} projectId={projectId} onChange={side.change} onNavigate={close} /> : null}
        <div className="side-full" hidden={collapsed}>
          <button type="button" className="icon-btn side-close" aria-label="Close" onClick={close}>×</button>
          {side.wide ? <SideHead onChange={side.change} /> : null}
          <Sidebar activeChatId={chatId} activeProjectId={projectId} options={options.data} onNavigate={close} />
          {standalone ? null : (
            <div className="side-chat-only">
              <a className="btn" href={chatOnlyUrl(location.origin, chatId, getToken())} target="_blank" rel="noopener">Open chat-only</a>
              <button type="button" className="btn" onClick={() => void navigator.clipboard?.writeText(chatOnlyUrl(location.origin, chatId, null)).then(() => { toast("ok", "link copied"); })}>Copy link</button>
            </div>
          )}
        </div>
      </aside>
      {side.wide && side.mode === "hidden" ? <SideFloat onChange={side.change} /> : null}
      {drawer ? <div className="scrim" onClick={close} aria-hidden="true" /> : null}
      <section className="chats-main">
        {chatId !== null ? (
          <ChatView key={chatId} chatId={chatId} onOpenDrawer={open} />
        ) : projectId !== null && draftRoute === null ? (
          <ProjectView key={projectId} projectId={projectId} onOpenDrawer={open} />
        ) : (
          <StartPage key={`${draftRoute?.projectId ?? ""}|${draftRoute?.folder ?? ""}`} projectId={draftRoute?.projectId ?? null} folder={draftRoute?.folder ?? null} onOpenDrawer={open} />
        )}
      </section>
    </div>
  );
}
