import { afterAll, expect, test } from "bun:test";
import { orch, seedHome, runState, cleanEnv, autoCleanup } from "../helpers";
autoCleanup();

// A test home must never record the live terminal as its coordinator: asks would be typed into the real session.
const saved = { HC_TERMINAL_ID: process.env.HC_TERMINAL_ID, HC_TERMINAL_SOCKET: process.env.HC_TERMINAL_SOCKET, HC_SCOPE: process.env.HC_SCOPE };
afterAll(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });

test("importing the helpers removes the live terminal identity from process.env", () => {
  for (const k of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HC_TERMINAL_SOCKET", "HC_SCOPE"]) expect(process.env[k]).toBeUndefined();
});

test("cleanEnv drops the hc terminal identity", () => {
  process.env.HC_TERMINAL_ID = "live-terminal";
  process.env.HC_TERMINAL_SOCKET = "/tmp/live.sock";
  process.env.HC_SCOPE = "live";
  const env = cleanEnv();
  expect(env.HC_TERMINAL_ID).toBeUndefined();
  expect(env.HC_TERMINAL_SOCKET).toBeUndefined();
  expect(env.HC_SCOPE).toBeUndefined();
});

test("a node ask in a test home records no coordinator from the live terminal", () => {
  process.env.HC_TERMINAL_ID = "live-terminal";
  const home = seedHome(), o = orch(home);
  o("run", "start", "Leak guard", "--id", "leak-1");
  o("node", "add", "leak-1", "a", "Ask");
  expect(o("node", "ask", "leak-1", "a", "which db?").rc).toBe(0);
  expect(runState(home, "leak-1").coordinator ?? null).toBeNull();
});
