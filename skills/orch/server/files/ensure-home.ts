import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { orchPaths } from "./paths";

const PROFILES_TEMPLATE: string = "profiles.json";
const EMPTY_MEMORY: string = "[]\n";
const SERVE_DIR_MODE: number = 0o700;

/** Seeds ORCH_HOME like bash `ensure_home`, so `bun server/main.ts --home X` stands alone. */
export function ensureHome(home: string, templatesDir: string): void {
  const paths = orchPaths(home);
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(paths.runs, { recursive: true });
  mkdirSync(paths.serveDir, { recursive: true, mode: SERVE_DIR_MODE });
  if (!existsSync(paths.profiles)) {
    copyFileSync(join(templatesDir, PROFILES_TEMPLATE), paths.profiles);
  }
  if (!existsSync(paths.memory)) {
    writeFileSync(paths.memory, EMPTY_MEMORY);
  }
}
