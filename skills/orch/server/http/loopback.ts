import type { Server } from "bun";

const IPV4_LOOPBACK_PREFIX: string = "127.";
const IPV6_LOOPBACK: string = "::1";
// Bun reports a v4 peer as `::ffff:127.0.0.1` when the socket is a dual-stack v6 listener.
const IPV4_MAPPED_PREFIX: string = "::ffff:";

/**
 * True for an address that can only belong to this machine: 127.0.0.0/8, ::1, or either of
 * those in IPv4-mapped form. A zone id (`::1%lo0`) is tolerated. Everything else — including
 * `0.0.0.0`, a LAN address and an empty string — is not loopback.
 */
export function isLoopbackAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase().split("%")[0] ?? "";
  if (normalized === "") {
    return false;
  }
  const unmapped = normalized.startsWith(IPV4_MAPPED_PREFIX)
    ? normalized.slice(IPV4_MAPPED_PREFIX.length)
    : normalized;
  if (unmapped === IPV6_LOOPBACK || normalized === IPV6_LOOPBACK) {
    return true;
  }
  return unmapped.startsWith(IPV4_LOOPBACK_PREFIX);
}

/**
 * True when the request's peer is on this machine. Bun hands route handlers the server as the
 * second argument; `requestIP` returns null once the socket is closed, which counts as "not
 * loopback" so a lost peer can never be treated as trusted.
 */
export function isLoopbackPeer(server: Server<undefined>, req: Request): boolean {
  const peer = server.requestIP(req);
  if (peer === null) {
    return false;
  }
  return isLoopbackAddress(peer.address);
}
