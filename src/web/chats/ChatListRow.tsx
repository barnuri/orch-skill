import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Chat } from "../lib/chat-types";
import { rel } from "../lib/format";
import { KebabIcon, TitleInput, useRenameChat } from "./rename";

/** True for the key that starts a rename on a focused row (F2, as in file managers). */
export function isRenameKey(e: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): boolean {
  return e.key === "F2" && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
}

/**
 * One chat in a list (sidebar or project page). The row's action menu holds Rename: on desktop the
 * menu button shows on hover or focus, on touch and narrow screens it is always visible. F2 on the
 * focused row starts the rename too. The title is edited in place; Enter or blur saves, Escape cancels.
 */
export function ChatListRow({ chat, href, active = false, meta, onNavigate }: {
  chat: Chat;
  href: string;
  active?: boolean;
  meta?: ReactNode;
  onNavigate?: () => void;
}) {
  const renameChat = useRenameChat();
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuId = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const link = useRef<HTMLAnchorElement>(null);
  const refocus = useRef(false);

  useEffect(() => {
    if (!menu) {
      return undefined;
    }
    const away = (e: Event): void => {
      if (!(wrap.current?.contains(e.target as Node) ?? false)) {
        setMenu(false);
      }
    };
    document.addEventListener("pointerdown", away);
    return () => {
      document.removeEventListener("pointerdown", away);
    };
  }, [menu]);

  useEffect(() => {
    if (!editing && refocus.current) {
      refocus.current = false;
      link.current?.focus();
    }
  }, [editing]);

  const start = (): void => {
    setMenu(false);
    setEditing(true);
  };
  const stop = (): void => {
    refocus.current = true;
    setEditing(false);
  };

  return (
    <div className="thread-row" ref={wrap} data-menu={menu || undefined} data-editing={editing || undefined}>
      {editing ? (
        <div className="thread thread-editing" aria-current={active ? "page" : undefined}>
          <TitleInput
            initial={chat.title}
            className="input thread-title-input"
            onSave={(value) => {
              stop();
              void renameChat(chat, value);
            }}
            onCancel={stop}
          />
          <span className="thread-meta">{meta}</span>
        </div>
      ) : (
        <a
          ref={link}
          className="thread"
          href={href}
          aria-current={active ? "page" : undefined}
          aria-keyshortcuts="F2"
          onClick={onNavigate}
          onKeyDown={(e) => {
            if (isRenameKey(e)) {
              e.preventDefault();
              start();
            }
          }}
        >
          <span className="thread-title">{chat.title}</span>
          <span className="thread-meta">{meta}</span>
        </a>
      )}
      {editing ? null : (
        <div className="thread-actions">
          <button
            type="button"
            className="icon-btn thread-menu-btn"
            aria-label={`Actions for ${chat.title}`}
            title="Chat actions"
            aria-haspopup="menu"
            aria-expanded={menu}
            aria-controls={menu ? menuId : undefined}
            onClick={() => {
              setMenu(!menu);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setMenu(false);
              }
            }}
          >
            <KebabIcon />
          </button>
          {menu ? (
            <div className="thread-menu" role="menu" id={menuId}>
              <button
                type="button"
                role="menuitem"
                className="thread-menu-item"
                autoFocus
                onClick={start}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setMenu(false);
                  }
                }}
              >
                Rename
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function chatMeta(chat: Chat): ReactNode {
  return (
    <>
      {chat.status === "running" ? <span className="thread-live" aria-label="running" /> : null}
      {chat.harness} · {rel(chat.updated_at)}
    </>
  );
}
