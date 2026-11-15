import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";

import { TempHome } from "../test-support/temp-home";
import { TOKEN_MODE, ensureToken } from "./token-file";

const BASE64URL_TOKEN: RegExp = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_FILE: string = "serve.token";

let home: TempHome;
let stderr: ReturnType<typeof spyOn>;

beforeEach(() => {
  home = TempHome.create();
  stderr = spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  stderr.mockRestore();
  home.dispose();
});

describe("ensureToken", () => {
  test("creates a 43-char base64url token with mode 0600", () => {
    const token = ensureToken(home.path);
    expect(token).toMatch(BASE64URL_TOKEN);
    expect(home.mode(TOKEN_FILE)).toBe(TOKEN_MODE);
    expect(home.read(TOKEN_FILE).trim()).toBe(token);
    expect(stderr).not.toHaveBeenCalled();
  });

  test("returns the same token on a second call", () => {
    const first = ensureToken(home.path);
    expect(ensureToken(home.path)).toBe(first);
  });

  test("repairs a loosened mode and warns on stderr", () => {
    const token = ensureToken(home.path);
    chmodSync(home.resolve(TOKEN_FILE), 0o644);
    expect(ensureToken(home.path)).toBe(token);
    expect(home.mode(TOKEN_FILE)).toBe(TOKEN_MODE);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain("0644");
  });

  test("reuses pre-existing content, trimmed", () => {
    writeFileSync(home.resolve(TOKEN_FILE), "  pre-seeded-token\n", { mode: TOKEN_MODE });
    expect(ensureToken(home.path)).toBe("pre-seeded-token");
  });

  test("reuses a file created before the server started", () => {
    writeFileSync(home.resolve(TOKEN_FILE), "external-token", { mode: TOKEN_MODE });
    expect(ensureToken(home.path)).toBe("external-token");
    expect(stderr).not.toHaveBeenCalled();
  });

  test("refuses an existing empty token file", () => {
    writeFileSync(home.resolve(TOKEN_FILE), "", { mode: TOKEN_MODE });
    expect(() => ensureToken(home.path)).toThrow(/exists but is empty/);
  });
});
