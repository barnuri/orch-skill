const ANY_BIND_HOST: string = "0.0.0.0";
const LOCALHOST: string = "localhost";
const IPV4_LITERAL: RegExp = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV6_CHARS: RegExp = /^[0-9a-f:.]+$/;

/**
 * DNS-rebinding guard for /api/*: the Host header must name this machine.
 * Allowed: IPv4/IPv6 literals, `localhost`, the bind host (unless 0.0.0.0),
 * and the OS hostname — with or without a domain part on either side.
 */
export function hostAllowed(
  hostHeader: string | null,
  bindHost: string,
  hostname: string,
): boolean {
  if (hostHeader === null) {
    return false;
  }
  const host = stripPort(hostHeader.trim()).toLowerCase();
  if (host === "") {
    return false;
  }
  if (IPV4_LITERAL.test(host) || isIpv6Literal(host)) {
    return true;
  }
  if (host === LOCALHOST) {
    return true;
  }
  if (bindHost !== ANY_BIND_HOST && host === bindHost.toLowerCase()) {
    return true;
  }
  return matchesHostname(host, hostname.toLowerCase());
}

function stripPort(host: string): string {
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    return close === -1 ? "" : host.slice(0, close + 1);
  }
  const firstColon = host.indexOf(":");
  if (firstColon === -1 || firstColon !== host.lastIndexOf(":")) {
    // No port, or a bare IPv6 literal (several colons, no brackets).
    return host;
  }
  return host.slice(0, firstColon);
}

function isIpv6Literal(host: string): boolean {
  const inner = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return inner.includes(":") && IPV6_CHARS.test(inner);
}

function firstLabel(name: string): string {
  return name.split(".")[0] ?? name;
}

function matchesHostname(host: string, hostname: string): boolean {
  if (hostname === "") {
    return false;
  }
  const accepted = new Set<string>([hostname, firstLabel(hostname)]);
  return accepted.has(host) || accepted.has(firstLabel(host));
}
