// Socket-vs-direct: the same core command gives the same code and output in both paths.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startCliSocket } from "../../../src/server/cli-socket.ts";
import { main } from "./cli.ts";
import { viaServer } from "./client.ts";
import { captured } from "./io.ts";

let home = "";
let sock: { stop: () => void } | null = null;
const cases = [["suggest", "list"], ["suggest", "scan"], ["suggest", "bogus"], ["serve", "config", "show"], ["serve", "config", "get", "port"], ["serve", "status", "--json"]];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "orch-sock-"));
  process.env.HARNESS_ORCH_HOME = home;
  sock = startCliSocket(home);
});

afterAll(() => sock?.stop());

test("a server socket answers every served command like the direct path", async () => {
  expect(sock).not.toBeNull();
  for (const argv of cases) {
    const direct = await captured({ HARNESS_ORCH_HOME: home }, () => main(argv, { direct: true }));
    const remote = await viaServer(home, argv);
    expect(remote).not.toBeNull();
    expect(remote!.code).toBe(direct.code);
    expect(remote!.stdout).toBe(direct.stdout);
    expect(remote!.stderr).toBe(direct.stderr);
  }
});

test("without a socket the client returns null so the CLI runs direct", async () => {
  expect(await viaServer(mkdtempSync(join(tmpdir(), "orch-nosock-")), ["suggest", "list"])).toBeNull();
});

test("a command the server does not serve is refused", async () => {
  expect(await viaServer(home, ["demo", "seed"])).toBeNull();
});
