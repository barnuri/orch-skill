import { describe, expect, test } from "bun:test";

import { hostAllowed } from "./host-policy";

const ANY_BIND: string = "0.0.0.0";
const LOOPBACK_BIND: string = "127.0.0.1";
const HOSTNAME: string = "MyMac.local";

describe("hostAllowed", () => {
  test("allows IPv4 literals with and without a port", () => {
    expect(hostAllowed("192.168.1.20:6724", ANY_BIND, HOSTNAME)).toBe(true);
    expect(hostAllowed("127.0.0.1", ANY_BIND, HOSTNAME)).toBe(true);
  });

  test("allows localhost:6724", () => {
    expect(hostAllowed("localhost:6724", ANY_BIND, HOSTNAME)).toBe(true);
    expect(hostAllowed("LOCALHOST", ANY_BIND, HOSTNAME)).toBe(true);
  });

  test("allows IPv6 literals, bracketed with a port or bare", () => {
    expect(hostAllowed("[::1]:6724", ANY_BIND, HOSTNAME)).toBe(true);
    expect(hostAllowed("[fe80::1]", ANY_BIND, HOSTNAME)).toBe(true);
    expect(hostAllowed("::1", ANY_BIND, HOSTNAME)).toBe(true);
  });

  test("allows the machine hostname with or without its domain part", () => {
    expect(hostAllowed("mymac.local:6724", ANY_BIND, HOSTNAME)).toBe(true);
    expect(hostAllowed("mymac", ANY_BIND, HOSTNAME)).toBe(true);
    expect(hostAllowed("mymac.lan", ANY_BIND, HOSTNAME)).toBe(true);
    expect(hostAllowed("MyMac.local", ANY_BIND, "mymac")).toBe(true);
  });

  test("allows the bind host only when it is not 0.0.0.0", () => {
    expect(hostAllowed("orch.internal:6724", "orch.internal", HOSTNAME)).toBe(true);
    expect(hostAllowed("0.0.0.0", ANY_BIND, HOSTNAME)).toBe(true);
    expect(hostAllowed("orch.internal", LOOPBACK_BIND, HOSTNAME)).toBe(false);
  });

  test("rejects foreign hosts", () => {
    expect(hostAllowed("evil.test", ANY_BIND, HOSTNAME)).toBe(false);
    expect(hostAllowed("evil.test:6724", LOOPBACK_BIND, HOSTNAME)).toBe(false);
    expect(hostAllowed("localhost.evil.test", ANY_BIND, HOSTNAME)).toBe(false);
  });

  test("rejects a missing, empty, or malformed header", () => {
    expect(hostAllowed(null, ANY_BIND, HOSTNAME)).toBe(false);
    expect(hostAllowed("", ANY_BIND, HOSTNAME)).toBe(false);
    expect(hostAllowed("   ", ANY_BIND, HOSTNAME)).toBe(false);
    expect(hostAllowed("[::1", ANY_BIND, HOSTNAME)).toBe(false);
  });
});
