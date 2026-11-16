import { existsSync } from "node:fs";
import { which } from "./util.ts";

export function findChrome(): string | null {
  for (const c of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    which("google-chrome"),
    which("chromium"),
    which("chromium-browser"),
  ]) {
    if (c && existsSync(c)) return c;
  }
  return null;
}
