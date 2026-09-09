import { describe, expect, test } from "bun:test";
import { hostname } from "node:os";

import { DEFAULT_HOST, DEFAULT_PORT, SERVE_USAGE, parseServeArgs, urlsFor } from "./cli";

const HOME: string = "/tmp/orch-home";
const HARNESSES: string = "claude cursor-agent opencode local-llm";
const OUTCOMES: string = "success failure partial";
const TOKEN: string = "abc123_-XYZ";

function requiredArgs(): string[] {
  return ["--home", HOME, "--harnesses", HARNESSES, "--outcomes", OUTCOMES];
}

describe("parseServeArgs", () => {
  test("applies the pinned defaults for host and port", () => {
    const args = parseServeArgs(requiredArgs());
    expect(args.home).toBe(HOME);
    expect(args.host).toBe("0.0.0.0");
    expect(args.host).toBe(DEFAULT_HOST);
    expect(args.port).toBe(6724);
    expect(args.port).toBe(DEFAULT_PORT);
  });

  test("honours --host", () => {
    const args = parseServeArgs([...requiredArgs(), "--host", "127.0.0.1"]);
    expect(args.host).toBe("127.0.0.1");
  });

  test("accepts --port 0 as the ephemeral port", () => {
    expect(parseServeArgs([...requiredArgs(), "--port", "0"]).port).toBe(0);
    expect(parseServeArgs([...requiredArgs(), "--port", "65535"]).port).toBe(65535);
  });

  test("rejects --port 70000 and non-integer ports", () => {
    expect(() => parseServeArgs([...requiredArgs(), "--port", "70000"])).toThrow(
      "serve: --port expects 0-65535",
    );
    expect(() => parseServeArgs([...requiredArgs(), "--port", "abc"])).toThrow(
      "serve: --port expects 0-65535",
    );
    expect(() => parseServeArgs([...requiredArgs(), "--port", "-1"])).toThrow(
      "serve: --port expects 0-65535",
    );
  });

  test("rejects an unknown flag with the usage line appended", () => {
    expect(() => parseServeArgs([...requiredArgs(), "--bogus", "x"])).toThrow(
      `serve: unknown argument --bogus\n  usage: ${SERVE_USAGE}`,
    );
  });

  test("splits --harnesses and --outcomes on whitespace into readonly lists", () => {
    const args = parseServeArgs([
      "--home",
      HOME,
      "--harnesses",
      "  claude   cursor-agent\topencode ",
      "--outcomes",
      OUTCOMES,
    ]);
    expect(args.harnesses).toEqual(["claude", "cursor-agent", "opencode"]);
    expect(args.outcomes).toEqual(["success", "failure", "partial"]);
  });

  test("requires --home, --harnesses and --outcomes", () => {
    expect(() =>
      parseServeArgs(["--harnesses", HARNESSES, "--outcomes", OUTCOMES]),
    ).toThrow("serve: --home is required");
    expect(() => parseServeArgs(["--home", HOME, "--outcomes", OUTCOMES])).toThrow(
      "serve: --harnesses is required",
    );
    expect(() => parseServeArgs(["--home", HOME, "--harnesses", HARNESSES])).toThrow(
      "serve: --outcomes is required",
    );
  });

  test("rejects a flag without a value, an empty host, and an empty enum list", () => {
    expect(() => parseServeArgs([...requiredArgs(), "--port"])).toThrow(
      "serve: --port expects a value",
    );
    expect(() => parseServeArgs([...requiredArgs(), "--host", "--port", "1"])).toThrow(
      "serve: --host expects a value",
    );
    expect(() => parseServeArgs([...requiredArgs(), "--host", ""])).toThrow(
      "serve: --host expects a hostname or address",
    );
    expect(() => parseServeArgs(["--home", HOME, "--harnesses", " ", "--outcomes", OUTCOMES])).toThrow(
      "serve: --harnesses expects at least one value",
    );
  });
});

describe("urlsFor", () => {
  test("0.0.0.0 yields the loopback URL followed by the hostname URL", () => {
    const urls = urlsFor("0.0.0.0", 6724, TOKEN);
    expect(urls[0]).toBe(`http://127.0.0.1:6724/?token=${TOKEN}`);
    expect(urls).toContain(`http://${hostname()}:6724/?token=${TOKEN}`);
    expect(urls.length).toBe(2);
  });

  test("127.0.0.1 yields the loopback URL only", () => {
    expect(urlsFor("127.0.0.1", 6724, TOKEN)).toEqual([
      `http://127.0.0.1:6724/?token=${TOKEN}`,
    ]);
  });

  test("any other bind host yields itself only, bracketing IPv6 literals", () => {
    expect(urlsFor("192.168.1.20", 8080, TOKEN)).toEqual([
      `http://192.168.1.20:8080/?token=${TOKEN}`,
    ]);
    expect(urlsFor("::1", 8080, TOKEN)).toEqual([`http://[::1]:8080/?token=${TOKEN}`]);
  });
});
