import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { installDom } from "../test/dom";

const uninstall = installDom();
for (const key of ["location", "history", "sessionStorage"] as const) {
  Object.defineProperty(globalThis, key, { value: (window as unknown as Record<string, unknown>)[key], configurable: true, writable: true });
}
const { render, screen, fireEvent, cleanup, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ensureManifestLink, manifestHref } = await import("./head");
const { appOfPath, chatIdOfHash, isIos } = await import("./app");
const { minutesToTime, timeToMinutes, subscriptionId } = await import("./push-client");
const { dismissKey } = await import("./install");
const { PwaChrome } = await import("./PwaChrome");
const { NotificationsSection } = await import("./NotificationsSection");
const { safeClickUrl } = await import("../../shared/push");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
  localStorage.clear();
  document.head.querySelectorAll('link[rel="manifest"]').forEach((n) => n.remove());
});
afterAll(uninstall);

const wrap = (node: React.ReactNode) => <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>;

describe("pwa helpers", () => {
  test("each app gets its own manifest link, once", () => {
    expect(manifestHref("/")).toBe("/manifest.webmanifest");
    expect(manifestHref("/chat")).toBe("/chat/manifest.webmanifest");
    expect(manifestHref("/chat/x")).toBe("/chat/manifest.webmanifest");
    expect(manifestHref("/chats")).toBe("/manifest.webmanifest");
    const a = ensureManifestLink(document, "/chat/");
    expect(ensureManifestLink(document, "/chat/")).toBe(a);
    expect(document.head.querySelectorAll('link[rel="manifest"]')).toHaveLength(1);
  });

  test("app and chat id from the location", () => {
    expect(appOfPath("/chat/")).toBe("chat");
    expect(appOfPath("/chatter")).toBe("dashboard");
    expect(chatIdOfHash("#/chats/chat-123")).toBe("chat-123");
    expect(chatIdOfHash("#/chats/new")).toBeNull();
    expect(chatIdOfHash("#/chats")).toBeNull();
    expect(chatIdOfHash("#/run/abc")).toBeNull();
    expect(isIos("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari")).toBe(true);
    expect(isIos("Mozilla/5.0 (Linux; Android 14) Chrome/120")).toBe(false);
  });

  test("quiet-hours times round trip; the subscription id matches the server's", async () => {
    expect(minutesToTime(22 * 60 + 5)).toBe("22:05");
    expect(timeToMinutes("07:30")).toBe(450);
    const { createHash } = await import("node:crypto");
    expect(await subscriptionId("https://push.example/1")).toBe(createHash("sha256").update("https://push.example/1").digest("hex").slice(0, 16));
  });

  test("notificationclick urls: same-origin only (the worker uses the same function)", () => {
    expect(safeClickUrl("/chat/#/chats/c1", "https://h")).toBe("/chat/#/chats/c1");
    expect(safeClickUrl("//evil.example/x", "https://h")).toBe("/");
  });
});

describe("notifications section", () => {
  test("on plain http it says push needs https and shows the secure link and /trust", async () => {
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    globalThis.fetch = (async (url: string) =>
      new Response(JSON.stringify(String(url).includes("server-info") ? { https_port: 6725, https_listening: true, https_url: "https://box.ts.net:6725/", trust_path: "/trust", cert_source: "localca", cert_expires: null, problem: null, secure_link_hint: true } : {}), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    render(wrap(<NotificationsSection />));
    expect(screen.getByText(/need a secure link/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText("https://box.ts.net:6725/")).toBeTruthy());
    expect(screen.getByText("/trust").getAttribute("href")).toContain("/trust");
    expect(screen.queryByRole("switch")).toBeNull();
  });

  test("the install row is there and offers no button without a browser prompt", () => {
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    render(wrap(<NotificationsSection />));
    expect(screen.getByText("Install Orch")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });
});

describe("install prompt", () => {
  test("a beforeinstallprompt shows a dismissable bar and the dismissal is remembered per app", async () => {
    render(wrap(<PwaChrome />));
    const ev = new Event("beforeinstallprompt", { cancelable: true }) as Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
    let prompted = false;
    ev.prompt = async () => void (prompted = true);
    ev.userChoice = Promise.resolve({ outcome: "accepted" });
    window.dispatchEvent(ev);
    await waitFor(() => expect(screen.getByText("Install Orch as an app.")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(prompted).toBe(true));
    window.dispatchEvent(Object.assign(new Event("beforeinstallprompt", { cancelable: true }), { prompt: async () => {}, userChoice: Promise.resolve({ outcome: "dismissed" }) }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(localStorage.getItem(dismissKey("dashboard"))).toBe("1");
    expect(screen.queryByText(/as an app/)).toBeNull();
  });
});
