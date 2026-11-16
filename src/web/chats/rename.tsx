import { useQueryClient } from "@tanstack/react-query";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { CHAT_TITLE_MAX } from "../../shared/dto/chats";
import { chatsApi } from "../api/chats";
import { describeFailure } from "../api/result";
import { useToast } from "../components/Toast";
import type { Chat, Page } from "../lib/chat-types";
import { refreshChats } from "./queries";

/** What a typed title means: nothing to send, an empty title to refuse, or the trimmed and capped title to save. */
export type TitleCheck = { kind: "same" } | { kind: "empty" } | { kind: "save"; title: string };

export function checkTitle(raw: string, current: string): TitleCheck {
  const title = raw.trim().slice(0, CHAT_TITLE_MAX);
  if (title === "") {
    return { kind: "empty" };
  }
  return title === current ? { kind: "same" } : { kind: "save", title };
}

type ChatPages = InfiniteData<Page<Chat>, string | null>;

/** Writes `title` into every cached copy of the chat: each chat-list page and the chat itself. */
function setCachedTitle(client: QueryClient, id: string, title: string): void {
  client.setQueriesData<ChatPages>({ queryKey: ["chats"] }, (data) =>
    data === undefined || !Array.isArray(data.pages) ? data : { ...data, pages: data.pages.map((page) => ({ ...page, items: page.items.map((c) => (c.id === id ? { ...c, title } : c)) })) },
  );
  client.setQueryData<Chat>(["chat", id], (chat) => (chat === undefined ? chat : { ...chat, title }));
}

/**
 * Renames a chat the same way from the header and from the lists: the new title shows at once in
 * every cached copy, goes back to the old one when the server refuses, and the lists refetch after.
 * Resolves true when the title was saved (or nothing needed saving).
 */
export function useRenameChat(): (chat: Pick<Chat, "id" | "title">, raw: string) => Promise<boolean> {
  const client = useQueryClient();
  const toast = useToast();
  return useCallback(
    async (chat, raw) => {
      const check = checkTitle(raw, chat.title);
      if (check.kind === "same") {
        return true;
      }
      if (check.kind === "empty") {
        toast("error", "A chat title cannot be empty");
        return false;
      }
      setCachedTitle(client, chat.id, check.title);
      const res = await chatsApi.rename(chat.id, check.title);
      if (res.kind !== "ok") {
        setCachedTitle(client, chat.id, chat.title);
        toast("error", describeFailure(res, "could not rename"));
        void refreshChats(client);
        return false;
      }
      void refreshChats(client);
      return true;
    },
    [client, toast],
  );
}

/** The inline title field: Enter and blur save, Escape cancels. It reports once, then the caller unmounts it. */
export function TitleInput({ initial, className, onSave, onCancel }: { initial: string; className: string; onSave: (value: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const [done, setDone] = useState(false);
  const finish = (save: boolean): void => {
    if (done) {
      return;
    }
    setDone(true);
    if (save) {
      onSave(value);
    } else {
      onCancel();
    }
  };
  return (
    <input
      className={className}
      aria-label="Chat title"
      value={value}
      maxLength={CHAT_TITLE_MAX}
      autoFocus
      onFocus={(e) => {
        e.currentTarget.select();
      }}
      onChange={(e) => {
        setValue(e.target.value);
      }}
      onBlur={() => {
        finish(true);
      }}
      onClick={(e) => {
        e.stopPropagation();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        }
      }}
    />
  );
}

export function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

export function KebabIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="12" cy="19" r="1.8" />
    </svg>
  );
}
