import { useEffect } from "react";
import { chatsApi } from "../api/chats";
import { normalizeSelection } from "../lib/chat-logic";
import { useConnection, useAuthRequired } from "../shell/use-connection";
import { TokenGate } from "../shell/TokenGate";
import { useRoute } from "../router/use-route";
import { ChatFrameContext } from "./chat-frame";
import { ChatsPage } from "./ChatsPage";
import { chatOnlyHash } from "./chat-only-link";
import { refreshChats } from "./queries";

/** Starts a chat in `folder` and opens it; the sidebar's own "New chat" has no folder. */
async function startInFolder(folder: string): Promise<void> {
  const options = await chatsApi.options();
  const sel = options.kind === "ok" ? normalizeSelection(options.body, null) : { harness: "", profile: "", model: null };
  const res = await chatsApi.createChat({ project_id: null, harness: sel.harness, profile: sel.profile, model_id: sel.model, cwd: folder });
  if (res.kind === "ok") {
    void refreshChats();
    location.hash = `#/chats/${encodeURIComponent(res.body.id)}`;
  }
}

/** Thin shell: the dashboard's Chats page alone: no rail, no header, no banner. Deep links `/chat/<id>`, `?project=`, `?folder=` map onto its hash routes. */
export function ChatShell() {
  const route = useRoute();
  const authRequired = useAuthRequired();
  const conn = useConnection();
  useEffect(() => {
    const hash = chatOnlyHash(location.pathname, location.search);
    if (hash !== null && location.hash === "") {
      location.hash = hash;
      return;
    }
    const folder = new URLSearchParams(location.search).get("folder");
    if (hash === null && folder !== null && folder !== "" && location.hash === "") {
      void startInFolder(folder);
    }
  }, []);
  const offline = conn.lastError !== null && !authRequired;
  if (authRequired) {
    return <main id="main"><TokenGate /></main>;
  }
  const chatId = route.kind === "chats" ? route.chatId : null;
  const projectId = route.kind === "project" ? route.projectId : route.kind === "chats" ? route.projectId ?? null : null;
  return (
    <main id="main" className="chat-only-main">
      {offline ? <span className="chat-only-dot is-error" role="status" aria-label="Offline" title="Offline" /> : null}
      <ChatFrameContext.Provider value={{ standalone: true }}>
        <ChatsPage chatId={chatId} projectId={projectId} />
      </ChatFrameContext.Provider>
    </main>
  );
}
