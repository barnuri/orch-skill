import { useEffect, useState } from "react";
import { chatsApi } from "../api/chats";
import { describeFailure } from "../api/result";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";
import type { Project } from "../lib/chat-types";
import { rel } from "../lib/format";
import { newChatHash } from "../router/route";
import { refreshChats, refreshProjects, useChats, useProjects } from "./queries";
import { ChatListRow } from "./ChatListRow";
import { FolderChip, FolderPicker } from "./FolderPicker";

export function ProjectView({ projectId, onOpenDrawer }: { projectId: string; onOpenDrawer: () => void }) {
  const toast = useToast();
  const active = useProjects(false);
  const archivedList = useProjects(true);
  const chats = useChats(false);
  const project: Project | undefined = [...(active.data ?? []), ...(archivedList.data ?? [])].find((p) => p.id === projectId);
  const [name, setName] = useState("");
  const [picking, setPicking] = useState(false);
  const [description, setDescription] = useState("");
  const [subName, setSubName] = useState("");
  useEffect(() => {
    if (project !== undefined) {
      setName(project.name);
      setDescription(project.description);
    }
  }, [project?.id, project?.name, project?.description]);
  const newChat = (): void => {
    location.hash = newChatHash({ projectId });
  };
  if (project === undefined) {
    return <div className="chat-empty"><p className="muted">{active.isLoading ? "Loading…" : "Project not found."}</p></div>;
  }
  const mine = chats.chats.filter((c) => c.project_id === projectId);
  const all = [...(active.data ?? []), ...(archivedList.data ?? [])];
  const parent = project.parent_id == null ? undefined : all.find((p) => p.id === project.parent_id);
  const subs = (archivedList.data ?? active.data ?? []).filter((p) => p.parent_id === projectId).sort((a, b) => a.id.localeCompare(b.id));
  const canHaveSubs = project.parent_id == null && project.archived_at === null;
  const addSub = async (): Promise<void> => {
    const res = await chatsApi.createProject({ name: subName.trim(), parent_id: projectId });
    if (res.kind !== "ok") {
      toast("error", describeFailure(res, "could not create the sub project"));
      return;
    }
    setSubName("");
    void refreshProjects();
    location.hash = `#/projects/${encodeURIComponent(res.body.id)}`;
  };
  const save = async (): Promise<void> => {
    const res = await chatsApi.updateProject(projectId, { name: name.trim(), description });
    toast(res.kind === "ok" ? "ok" : "error", res.kind === "ok" ? "Project saved" : describeFailure(res, "could not save"));
    void refreshProjects();
  };
  const pickFolder = async (path: string | null): Promise<string | null> => {
    const res = await chatsApi.setProjectFolder(projectId, path);
    void refreshProjects();
    void refreshChats();
    return res.kind === "ok" ? null : describeFailure(res, "could not set the folder");
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
      {parent === undefined ? null : (
        <p className="project-parent" data-testid="project-parent">
          Sub project of <a href={`#/projects/${encodeURIComponent(parent.id)}`}>{parent.name}</a>
        </p>
      )}
      <form className="project-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="field-group"><span className="field-label">Name</span><input value={name} onChange={(e) => { setName(e.target.value); }} required /></label>
        <div className="field-group">
          <span className="field-label">Folder (chats of this project run here unless they have their own)</span>
          <span className="chat-folder-row">
            <FolderChip path={project.path} onClick={() => { setPicking(true); }} />
            {project.path === null ? null : <button type="button" className="btn" onClick={() => void pickFolder(null)}>Clear</button>}
          </span>
        </div>
        <label className="field-group"><span className="field-label">Description</span><textarea value={description} onChange={(e) => { setDescription(e.target.value); }} rows={3} /></label>
        <div className="project-actions">
          <button type="submit" className="btn primary" disabled={name.trim() === ""}>Save</button>
          <button type="button" className="btn" onClick={() => void archive()}>{project.archived_at === null ? "Archive project" : "Unarchive project"}</button>
          <button type="button" className="btn" onClick={newChat} disabled={project.archived_at !== null}>New chat here</button>
        </div>
      </form>
      {picking ? <FolderPicker title="Folder for this project" current={project.path} onPick={pickFolder} onClose={() => { setPicking(false); }} /> : null}
      {project.parent_id == null ? (
        <>
          <h2 className="section-title">Sub projects</h2>
          {subs.length === 0 ? null : (
            <ul className="subproject-list" data-testid="subproject-list">
              {subs.map((s) => (
                <li key={s.id}>
                  <a href={`#/projects/${encodeURIComponent(s.id)}`}>{s.name}</a>
                  {s.archived_at === null ? null : <span className="tag">archived</span>}
                  <FolderChip path={s.path} />
                </li>
              ))}
            </ul>
          )}
          {canHaveSubs ? (
            <form className="subproject-form" onSubmit={(e) => { e.preventDefault(); void addSub(); }}>
              <input className="input" aria-label="Sub project name" placeholder={project.path === null ? "Sub project name" : "Sub project name (its folder inside the project folder)"} value={subName} onChange={(e) => { setSubName(e.target.value); }} />
              <button type="submit" className="btn" disabled={subName.trim() === ""}>New sub project</button>
            </form>
          ) : null}
        </>
      ) : null}
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
