import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { chatsApi } from "../api/chats";
import { ApiFailure, queryClient } from "../api/queries";
import type { ApiResult } from "../api/result";
import type { Chat, ChatOptions, Project } from "../lib/chat-types";

const REFRESH_MS = 5000;

function unwrap<T>(result: ApiResult<T>): T {
  if (result.kind === "ok") {
    return result.body;
  }
  throw new ApiFailure(result as Exclude<ApiResult<T>, { kind: "ok" }>);
}

export const chatKeys = {
  options: ["chat-options"] as const,
  projects: (archived: boolean) => ["projects", archived] as const,
  chats: (archived: boolean) => ["chats", archived] as const,
  chat: (id: string) => ["chat", id] as const,
  folders: (root: string) => ["chat-folders", root] as const,
  search: (q: string) => ["chat-search", q] as const,
};

export function useChatOptions(use?: "runs") {
  return useQuery<ChatOptions>({ queryKey: use === undefined ? chatKeys.options : [...chatKeys.options, use], queryFn: async () => unwrap(await chatsApi.options(use)), staleTime: 30_000 });
}

export function useProjects(archived: boolean) {
  return useQuery<Project[]>({
    queryKey: chatKeys.projects(archived),
    queryFn: async () => unwrap(await chatsApi.projects(archived)).items,
    refetchInterval: REFRESH_MS,
  });
}

export function useChats(archived: boolean) {
  const query = useInfiniteQuery({
    queryKey: chatKeys.chats(archived),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => unwrap(await chatsApi.chats({ archived, cursor: pageParam })),
    getNextPageParam: (last) => last.next_cursor,
    refetchInterval: REFRESH_MS,
  });
  const chats: Chat[] = query.data?.pages.flatMap((p) => p.items) ?? [];
  return { ...query, chats };
}

export function useFolders(root: string) {
  return useQuery({ queryKey: chatKeys.folders(root), queryFn: async () => unwrap(await chatsApi.folders(root === "" ? undefined : root)), staleTime: 10_000 });
}

/** Existing child folders of a project folder, two levels deep, relative to it: the suggestions of the Subfolder field. */
export function useSubfolderSuggestions(projectPath: string | null) {
  return useQuery({
    queryKey: ["chat-folders", projectPath ?? "", 2] as const,
    enabled: projectPath !== null,
    queryFn: async () => unwrap(await chatsApi.folders(projectPath ?? undefined, 2)),
    staleTime: 10_000,
    select: (list) => list.items.map((i) => i.name),
  });
}

export function useChat(id: string) {
  return useQuery<Chat>({ queryKey: chatKeys.chat(id), queryFn: async () => unwrap(await chatsApi.chat(id)), refetchInterval: REFRESH_MS });
}

export function useChatSearch(text: string) {
  return useQuery({
    queryKey: chatKeys.search(text),
    enabled: text.trim() !== "",
    queryFn: async () => unwrap(await chatsApi.search(text.trim())).items,
  });
}

export function refreshChats(client: QueryClient = queryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: ["chats"] }).then(() => client.invalidateQueries({ queryKey: ["chat"] }));
}

export function refreshProjects(client: QueryClient = queryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: ["projects"] });
}
