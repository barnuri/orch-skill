import { draftScope, setDraftText } from "../lib/chat-draft";
import { newChatHash } from "../router/route";

/** The chat app's share target lands on `/chat/?share=<text>`: it becomes the draft of a new chat, and the address is cleaned. */
export function consumeShare(): boolean {
  const q = new URLSearchParams(location.search);
  const text = q.get("share");
  if (text === null || text === "") return false;
  setDraftText(draftScope(null), text);
  q.delete("share");
  const rest = q.toString();
  history.replaceState(null, "", `${location.pathname}${rest === "" ? "" : `?${rest}`}${newChatHash()}`);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  return true;
}
