import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, openSync, readFileSync, statSync, writeSync } from "node:fs";

import { orchPaths } from "./paths";

export const TOKEN_BYTES: number = 32;
export const TOKEN_MODE: number = 0o600;

const PERMISSION_MASK: number = 0o777;
const GROUP_OTHER_MASK: number = 0o077;
const OCTAL_RADIX: number = 8;
const OCTAL_WIDTH: number = 4;

/**
 * Returns the bearer token from `<home>/serve.token`, creating it (`wx`, 0600)
 * when absent. An existing token is reused and its mode repaired to 0600; a
 * concurrent start losing the `wx` race re-reads the winner's token.
 */
export function ensureToken(home: string): string {
  const path = orchPaths(home).tokenFile;
  const token = readExistingToken(path) ?? createToken(path) ?? readExistingToken(path);
  if (token === null) {
    throw new Error(`serve: ${path} exists but is empty; trash it and restart`);
  }
  warnIfReadableByOthers(path);
  return token;
}

function readExistingToken(path: string): string | null {
  if (!existsSync(path)) {
    return null;
  }
  const content = readFileSync(path, "utf8").trim();
  if (content === "") {
    return null;
  }
  repairMode(path);
  return content;
}

function createToken(path: string): string | null {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  let fd: number;
  try {
    fd = openSync(path, "wx", TOKEN_MODE);
  } catch (err) {
    if (errnoCode(err) === "EEXIST") {
      return null;
    }
    throw err;
  }
  try {
    writeSync(fd, `${token}\n`);
  } finally {
    closeSync(fd);
  }
  return token;
}

function repairMode(path: string): void {
  const mode = statSync(path).mode & PERMISSION_MASK;
  if (mode === TOKEN_MODE) {
    return;
  }
  chmodSync(path, TOKEN_MODE);
  console.error(`serve: repaired ${path} permissions from ${octal(mode)} to ${octal(TOKEN_MODE)}`);
}

function warnIfReadableByOthers(path: string): void {
  const mode = statSync(path).mode & PERMISSION_MASK;
  if ((mode & GROUP_OTHER_MASK) === 0) {
    return;
  }
  console.error(
    `serve: ${path} is readable by others (mode ${octal(mode)}); the filesystem may ignore chmod`,
  );
}

function octal(mode: number): string {
  return mode.toString(OCTAL_RADIX).padStart(OCTAL_WIDTH, "0");
}

function errnoCode(err: unknown): string | null {
  if (err instanceof Error && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return null;
}
