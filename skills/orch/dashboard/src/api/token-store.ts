import { TOKEN_KEY } from "../constants";

const TOKEN_PARAM: string = "token";

// `dispatch.sh ui` opens `/?token=<t>` once; the page keeps it in localStorage (per origin, so
// the fixed default port keeps it across restarts) and scrubs it from the address bar so it
// never lands in history, bookmarks or screenshots.
export function adoptTokenFromUrl(): void {
  const params = new URLSearchParams(location.search);
  const token = params.get(TOKEN_PARAM);
  if (token === null) {
    return;
  }
  if (token !== "") {
    setToken(token);
  }
  history.replaceState(null, "", `${location.pathname}${location.hash}`);
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}
