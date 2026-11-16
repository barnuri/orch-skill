import { useEffect, useMemo, useState } from "react";
import { chatsApi } from "../api/chats";
import { describeFailure } from "../api/result";
import { Toggle } from "../components/Toggle";
import { useToast } from "../components/Toast";
import { visibleChats } from "../lib/chat-logic";
import type { Chat, ChatOptions, Project } from "../lib/chat-types";
import { refreshChats, refreshProjects, useChatSearch, useChats, useProjects } from "./queries";
import { useSingleFlight } from "../lib/use-single-flight";
import { ChatListRow, chatMeta } from "./ChatListRow";
import { requestComposerFocus } from "./composer-focus";
import { draftScope } from "../lib/chat-draft";
import { newChatHash } from "../router/route";
import { setStartSeed } from "./start-seed";
import { useDraftScopes } from "./use-draft-scopes";

interface SidebarProps {
  activeChatId: string | null;
  activeProjectId: string | null;
  options: ChatOptions | undefined;
  onNavigate: () => void;
}

function snippetParts(snippet: string): { text: string; hit: boolean }[] {
  return snippet.split(/(\[\[.*?\]\])/g).filter(Boolean).map((part) => (part.startsWith("[[") ? { text: part.slice(2, -2), hit: true } : { text: part, hit: false }));
}

function useDebounced(value: string, ms: number): string {
  const [out, setOut] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setOut(value);
    }, ms);
    return () => {
      clearTimeout(timer);
    };
  }, [value, ms]);
  return out;
}

function ChatRow({ chat, active, onNavigate }: { chat: Chat; active: boolean; onNavigate: () => void }) {
  const href = chat.project_id === null ? `#/chats/${encodeURIComponent(chat.id)}` : `#/chats/${encodeURIComponent(chat.project_id)}/${encodeURIComponent(chat.id)}`;
  return <ChatListRow chat={chat} href={href} active={active} meta={chatMeta(chat)} onNavigate={onNavigate} />;
}

export function Sidebar({ activeChatId, activeProjectId, onNavigate }: SidebarProps) {
  const toast = useToast();
  const drafts = useDraftScopes();
  const [archived, setArchived] = useState(false);
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query, 250);
  const projects = useProjects(archived);
  const chats = useChats(archived);
  const search = useChatSearch(debounced);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");

  const groups = useMemo(() => {
    const byProject = new Map<string | null, Chat[]>();
    for (const chat of visibleChats(chats.chats, activeChatId, archived)) {
      byProject.set(chat.project_id, [...(byProject.get(chat.project_id) ?? []), chat]);
    }
    const out: { project: Project | null; chats: Chat[] }[] = (projects.data ?? []).map((project) => ({ project, chats: byProject.get(project.id) ?? [] }));
    out.push({ project: null, chats: byProject.get(null) ?? [] });
    const known = new Set((projects.data ?? []).map((p) => p.id));
    for (const [pid, list] of byProject) {
      if (pid !== null && !known.has(pid)) {
        out.splice(out.length - 1, 0, { project: { id: pid, name: pid, path: null, description: "", created_at: "", archived_at: "x" }, chats: list });
      }
    }
    return out;
  }, [chats.chats, projects.data, activeChatId, archived]);

  // Nothing is created here: the start page makes the chat when the first message is sent.
  const newChat = (projectId: string | null, like?: Chat): void => {
    setStartSeed(like === undefined ? null : { harness: like.harness, profile: like.profile, model: like.model_id });
    requestComposerFocus();
    onNavigate();
    location.hash = newChatHash({ projectId });
  };

  const [addProject, creatingProject] = useSingleFlight(async (): Promise<void> => {
    const res = await chatsApi.createProject({ name: name.trim(), path: path.trim() === "" ? null : path.trim() });
    if (res.kind !== "ok") {
      toast("error", describeFailure(res, "could not create the project"));
      return;
    }
    setAdding(false);
    setName("");
    setPath("");
    void refreshProjects();
    onNavigate();
    location.hash = `#/projects/${encodeURIComponent(res.body.id)}`;
  });

  const searching = debounced.trim() !== "";
  return (
    <div className="side">
      <div className="side-actions">
        <button type="button" className="btn primary" onClick={() => { newChat(activeProjectId); }}>
          
          New chat
        </button>
        <button
          type="button"
          className="btn"
          aria-expanded={adding}
          onClick={() => {
            setAdding(!adding);
          }}
        >
          New project
        </button>
      </div>
      {adding ? (
        <form
          className="side-form"
          onSubmit={(e) => {
            e.preventDefault();
            void addProject();
          }}
        >
          <input className="input" aria-label="Project name" placeholder="Project name" value={name} onChange={(e) => { setName(e.target.value); }} required autoFocus />
          <input className="input" aria-label="Directory" placeholder="Directory (optional, absolute path)" value={path} onChange={(e) => { setPath(e.target.value); }} />
          <button type="submit" className="btn primary" disabled={name.trim() === "" || creatingProject}>
            Create project
          </button>
        </form>
      ) : null}
      <input id="chat-search" className="input side-search" type="search" placeholder="Search all history (Ctrl+K)" aria-label="Search chats" value={query} onChange={(e) => { setQuery(e.target.value); }} />
      <div className="side-toggle">
        <Toggle on={archived} onChange={setArchived} label="Show archived" />
        <span>Archived</span>
      </div>
      <div className="side-scroll">
        {searching ? (
          <ul className="hits" aria-label="Search results">
            {(search.data ?? []).map((hit) => (
              <li key={hit.message_id}>
                <a href={`#/chats/${encodeURIComponent(hit.chat_id)}`} onClick={onNavigate}>
                  <span className="thread-title">{hit.chat_title}</span>
                  <span className="hit-snippet">
                    {snippetParts(hit.snippet).map((part, i) => (part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>))}
                  </span>
                </a>
              </li>
            ))}
            {search.data?.length === 0 ? <li className="side-empty">No matches.</li> : null}
          </ul>
        ) : (
          groups.map((group) => (
            <section key={group.project?.id ?? "none"} className="group">
              <h3 className="group-head">
                {group.project === null ? (
                  <span>No project</span>
                ) : (
                  <a href={`#/projects/${encodeURIComponent(group.project.id)}`} aria-current={group.project.id === activeProjectId ? "page" : undefined} onClick={onNavigate}>
                    {group.project.name}
                  </a>
                )}
                <span className="group-tools">
                  {drafts.includes(draftScope(group.project?.id ?? null)) ? <a className="draft-tag" href={newChatHash({ projectId: group.project?.id ?? null })} title="Unsent first message" onClick={onNavigate}>Draft</a> : null}
                  <span className="group-count">{group.chats.length}</span>
                  {archived || group.project?.archived_at != null ? null : (
                    <button
                      type="button"
                      className="icon-btn group-add"
                      aria-label={`New chat in ${group.project === null ? "No project" : group.project.name}`}
                      title={`New chat in ${group.project === null ? "No project" : group.project.name}`}
                      onClick={() => { newChat(group.project?.id ?? null, group.chats[0]); }}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                    </button>
                  )}
                </span>
              </h3>
              {group.chats.map((chat) => (
                <ChatRow key={chat.id} chat={chat} active={chat.id === activeChatId} onNavigate={onNavigate} />
              ))}
              {group.chats.length === 0 ? <p className="side-empty">No chats.</p> : null}
            </section>
          ))
        )}
        {!searching && chats.hasNextPage ? (
          <button type="button" className="btn side-more" disabled={chats.isFetchingNextPage} onClick={() => void chats.fetchNextPage()}>
            Load more
          </button>
        ) : null}
      </div>
    </div>
  );
}
