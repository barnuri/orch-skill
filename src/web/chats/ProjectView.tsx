import { useEffect, useState } from "react";
import { chatsApi } from "../api/chats";
import { describeFailure } from "../api/result";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";
import { normalizeSelection } from "../lib/chat-logic";
import type { Project } from "../lib/chat-types";
import { rel } from "../lib/format";
import { refreshChats, refreshProjects, useChatOptions, useChats, useProjects } from "./queries";
import { useSingleFlight } from "../lib/use-single-flight";
import { ChatListRow } from "./ChatListRow";

export function ProjectView({ projectId, onOpenDrawer }: { projectId: string; onOpenDrawer: () => void }) {
  const toast = useToast();
  const active = useProjects(false);
  const archivedList = useProjects(true);
  const options = useChatOptions();
  const chats = useChats(false);
  const project: Project | undefined = [...(active.data ?? []), ...(archivedList.data ?? [])].find((p) => p.id === projectId);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [description, setDescription] = useState("");
  useEffect(() => {
    if (project !== undefined) {
      setName(project.name);
      setPath(project.path ?? "");
      setDescription(project.description);
    }
  }, [project?.id, project?.name, project?.path, project?.description]);
  const [newChat, creating] = useSingleFlight(async (): Promise<void> => {
    const sel = options.data === undefined ? { harness: "", profile: "", model: null } : normalizeSelection(options.data, null);
    const res = await chatsApi.createChat({ project_id: projectId, harness: sel.harness, profile: sel.profile, model_id: sel.model });
    if (res.kind !== "ok") {
      toast("error", describeFailure(res, "could not create the chat"));
      return;
    }
    void refreshChats();
    location.hash = `#/chats/${encodeURIComponent(res.body.id)}`;
  });
  if (project === undefined) {
    return <div className="chat-empty"><p className="muted">{active.isLoading ? "Loading…" : "Project not found."}</p></div>;
  }
  const mine = chats.chats.filter((c) => c.project_id === projectId);
  const save = async (): Promise<void> => {
    const res = await chatsApi.updateProject(projectId, { name: name.trim(), path: path.trim() === "" ? null : path.trim(), description });
    toast(res.kind === "ok" ? "ok" : "error", res.kind === "ok" ? "Project saved" : describeFailure(res, "could not save"));
    void refreshProjects();
  };
  const archive = async (): Promise<void> => {
    const res = await chatsApi.archiveProject(projectId, project.archived_at === null);
    if (res.kind !== "ok") {
      toast("error", describeFailure(res, "could not archive"));
    }
    void refreshProjects();
  };
  return (
    <div className="project-view">
      <div className="chat-head">
        <button type="button" className="icon-btn drawer-btn" aria-label="Projects and chats" onClick={onOpenDrawer}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
        </button>
        <h1 className="project-title">{project.name}</h1>
        {project.archived_at !== null ? <span className="tag">archived</span> : null}
      </div>
      <form className="project-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="field-group"><span className="field-label">Name</span><input value={name} onChange={(e) => { setName(e.target.value); }} required /></label>
        <label className="field-group"><span className="field-label">Directory (chats run here)</span><input value={path} onChange={(e) => { setPath(e.target.value); }} placeholder="scratch directory" /></label>
        <label className="field-group"><span className="field-label">Description</span><textarea value={description} onChange={(e) => { setDescription(e.target.value); }} rows={3} /></label>
        <div className="project-actions">
          <button type="submit" className="btn primary" disabled={name.trim() === ""}>Save</button>
          <button type="button" className="btn" onClick={() => void archive()}>{project.archived_at === null ? "Archive project" : "Unarchive project"}</button>
          <button type="button" className="btn" onClick={() => void newChat()} disabled={project.archived_at !== null || creating}>New chat here</button>
        </div>
      </form>
      <h2 className="section-title">Chats</h2>
      {mine.length === 0 ? (
        <EmptyState title="No chats in this project yet">Start one with New chat here.</EmptyState>
      ) : (
        <div className="project-chats">
          {mine.map((c) => (
            <ChatListRow key={c.id} chat={c} href={`#/chats/${encodeURIComponent(c.id)}`} meta={<>{c.harness} · {rel(c.updated_at)}</>} />
          ))}
        </div>
      )}
    </div>
  );
}
