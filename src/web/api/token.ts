import { TOKEN_KEY } from "../lib/constants";

const TOKEN_PARAM = "token";

// `dispatch.ts ui` opens `/?token=<t>` once; the page keeps it in sessionStorage (per tab) and
// scrubs it from the address bar so it never lands in history, bookmarks or screenshots.
export function adoptTokenFromUrl(): void {
  const token = new URLSearchParams(location.search).get(TOKEN_PARAM);
  if (token === null) {
    return;
  }
  if (token !== "") {
    setToken(token);
  }
  const rest = new URLSearchParams(location.search);
  rest.delete(TOKEN_PARAM);
  const query = rest.toString();
  history.replaceState(null, "", `${location.pathname}${query === "" ? "" : `?${query}`}${location.hash}`);
}

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}
