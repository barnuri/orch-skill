import { useState } from "react";
import type { TodoItem } from "../../shared/chat-parts";

const MARK: Record<TodoItem["status"], string> = { pending: "not started", in_progress: "in progress", done: "done" };

export function todoProgress(items: readonly TodoItem[]): { done: number; total: number } {
  return { done: items.filter((t) => t.status === "done").length, total: items.length };
}

export function TodoList({ items }: { items: readonly TodoItem[] }) {
  return (
    <ul className="todo-list" data-testid="todo-list">
      {items.map((t, i) => (
        <li key={i} className={`todo-item is-${t.status}`} dir="auto">
          <input type="checkbox" className="task-box" checked={t.status === "done"} readOnly disabled aria-label={`${t.text}: ${MARK[t.status]}`} />
          <span className="todo-text">{t.text}</span>
          {t.status === "in_progress" ? <span className="todo-now">in progress</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** The agent's current checklist, pinned above the composer. Collapsible; shows the progress count. */
export function TodoPanel({ items }: { items: readonly TodoItem[] }) {
  const [open, setOpen] = useState(false);
  const { done, total } = todoProgress(items);
  const now = items.find((t) => t.status === "in_progress") ?? items.find((t) => t.status === "pending");
  return (
    <section className="todo-panel" data-testid="todo-panel" aria-label="Task list">
      <button type="button" className="todo-head" aria-expanded={open} onClick={() => { setOpen(!open); }}>
        <span className="tool-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span>Tasks</span>
        <span className="todo-count mono" data-testid="todo-count">{done}/{total}</span>
        {!open && now !== undefined ? <span className="todo-now-text" dir="auto">{now.text}</span> : null}
        <span className="todo-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label="Tasks done"><i style={{ width: `${total === 0 ? 0 : (done / total) * 100}%` }} /></span>
      </button>
      {open ? <TodoList items={items} /> : null}
    </section>
  );
}
