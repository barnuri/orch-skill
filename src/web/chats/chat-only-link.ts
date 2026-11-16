/** Hash the shared chat pages understand, for a `/chat` URL (`/chat/<id>`, `?project=`), or null when the URL names no target. */
export function chatOnlyHash(pathname: string, search: string): string | null {
  const params = new URLSearchParams(search);
  const rest = pathname.replace(/^\/chat\/?/, "");
  if (rest !== "" && rest !== "manifest.webmanifest") {
    try {
      return `#/chats/${encodeURIComponent(decodeURIComponent(rest.split("/")[0] ?? ""))}`;
    } catch {
      return null;
    }
  }
  const project = params.get("project");
  return project === null || project === "" ? null : `#/projects/${encodeURIComponent(project)}`;
}

/** Link to the chat-only page; `chatId` opens one thread. The token is added only for a new tab (sessionStorage is per tab). */
export function chatOnlyUrl(origin: string, chatId: string | null, token: string | null): string {
  const path = chatId === null ? "/chat" : `/chat/${encodeURIComponent(chatId)}`;
  return `${origin}${path}${token === null ? "" : `?token=${encodeURIComponent(token)}`}`;
}
