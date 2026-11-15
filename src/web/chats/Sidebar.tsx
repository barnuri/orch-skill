import { useEffect, useMemo, useState } from "react";
import { chatsApi } from "../api/chats";
import { describeFailure } from "../api/result";
import { Toggle } from "../components/Toggle";
import { useToast } from "../components/Toast";
import { normalizeSelection, visibleChats } from "../lib/chat-logic";
import type { Chat, ChatOptions, Project } from "../lib/chat-types";
import { rel } from "../lib/format";
import { refreshChats, refreshProjects, useChatSearch, useChats, useProjects } from "./queries";

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
  return (
    <a className="thread" href={chat.project_id === null ? `#/chats/${encodeURIComponent(chat.id)}` : `#/chats/${encodeURIComponent(chat.project_id)}/${encodeURIComponent(chat.id)}`} aria-current={active ? "page" : undefined} onClick={onNavigate}>
      <span className="thread-title">{chat.title}</span>
      <span className="thread-meta">
        {chat.status === "running" ? <span className="thread-live" aria-label="running" /> : null}
        {chat.harness} · {rel(chat.updated_at)}
      </span>
    </a>
  );
}

export function Sidebar({ activeChatId, activeProjectId, options, onNavigate }: SidebarProps) {
  const toast = useToast();
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

  const newChat = async (projectId: string | null): Promise<void> => {
    const sel = options === undefined ? { harness: "", profile: "", model: null } : normalizeSelection(options, null);
    const res = await chatsApi.createChat({ project_id: projectId, harness: sel.harness, profile: sel.profile, model_id: sel.model });
    if (res.kind !== "ok") {
      toast("error", describeFailure(res, "could not create the chat"));
      return;
    }
    void refreshChats();
    onNavigate();
    location.hash = `#/chats/${encodeURIComponent(res.body.id)}`;
  };

  const addProject = async (): Promise<void> => {
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
  };

  const searching = debounced.trim() !== "";
  return (
    <div className="side">
      <div className="side-actions">
        <button type="button" className="btn primary" onClick={() => void newChat(activeProjectId)}>
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
          <button type="submit" className="btn primary" disabled={name.trim() === ""}>
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
                <span className="group-count">{group.chats.length}</span>
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
