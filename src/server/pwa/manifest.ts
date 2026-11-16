export type PwaApp = "dashboard" | "chat";

// Design tokens (src/snapshot/tokens.css): --bg dark and light. The light value goes in the page's `theme-color` meta with a media query.
export const THEME_DARK = "#0b0d10";
export const THEME_LIGHT = "#f4f5f7";

export const APP_ID: Readonly<Record<PwaApp, string>> = { dashboard: "/", chat: "/chat/" };

const icons = (app: PwaApp): object[] => [
  { src: `/pwa/icons/${app}-192.png`, sizes: "192x192", type: "image/png", purpose: "any" },
  { src: `/pwa/icons/${app}-512.png`, sizes: "512x512", type: "image/png", purpose: "any" },
  { src: `/pwa/icons/${app}-maskable-512.png`, sizes: "512x512", type: "image/png", purpose: "maskable" },
];

/**
 * Two apps from one server. Chrome keys an installed app by `id`, so `/` and `/chat/` are different apps with their own
 * window and icon; the chat scope nests inside the dashboard's, and a link in the chat app stays in it.
 * `start_url` is `/chat/`, not `/chat`: a start URL outside the scope fails the install check.
 */
export function manifestFor(app: PwaApp): Record<string, unknown> {
  const common = {
    id: APP_ID[app],
    lang: "en",
    dir: "auto",
    display: "standalone",
    orientation: "any",
    theme_color: THEME_DARK,
    background_color: THEME_DARK,
    icons: icons(app),
  };
  if (app === "chat") {
    return {
      ...common,
      name: "Orch chat",
      short_name: "Orch chat",
      description: "Chat with your coding agents on your orch server.",
      scope: "/chat/",
      start_url: "/chat/",
      categories: ["productivity", "developer tools"],
      shortcuts: [{ name: "New chat", short_name: "New chat", url: "/chat/#/chats/new", icons: [{ src: "/pwa/icons/chat-192.png", sizes: "192x192", type: "image/png" }] }],
      share_target: { action: "/chat/share", method: "GET", params: { title: "title", text: "text", url: "url" } },
    };
  }
  return {
    ...common,
    name: "Orch",
    short_name: "Orch",
    description: "The orch dashboard: runs, chats, profiles and schedules.",
    scope: "/",
    start_url: "/",
    categories: ["productivity", "developer tools"],
    shortcuts: [
      { name: "Runs", short_name: "Runs", url: "/#/", icons: [{ src: "/pwa/icons/dashboard-192.png", sizes: "192x192", type: "image/png" }] },
      { name: "Chats", short_name: "Chats", url: "/#/chats", icons: [{ src: "/pwa/icons/dashboard-192.png", sizes: "192x192", type: "image/png" }] },
    ],
  };
}
