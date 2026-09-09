import { describe, expect, test } from "bun:test";

import { isLoopbackAddress } from "./loopback";

describe("isLoopbackAddress", () => {
  test.each([
    "127.0.0.1",
    "127.1.2.3",
    "127.255.255.255",
    "::1",
    "::ffff:127.0.0.1",
    "::FFFF:127.0.0.1",
    "::1%lo0",
    " 127.0.0.1 ",
  ])("accepts %s", (address: string) => {
    expect(isLoopbackAddress(address)).toBe(true);
  });

  test.each([
    "192.168.0.196",
    "10.0.0.4",
    "172.16.3.9",
    "0.0.0.0",
    "::",
    "::ffff:192.168.0.196",
    "128.0.0.1",
    "1.127.0.0",
    "",
    "   ",
    "localhost",
  ])("rejects %s", (address: string) => {
    expect(isLoopbackAddress(address)).toBe(false);
  });
});
