import { createHash, timingSafeEqual } from "node:crypto";

// Header-only: `?token=` is deliberately not accepted on /api/* (it leaks via logs and referrers).
const BEARER_PATTERN: RegExp = /^Bearer\s+(\S+)\s*$/i;
const DIGEST_ALGORITHM: string = "sha256";

export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header === null) {
    return null;
  }
  const match = BEARER_PATTERN.exec(header);
  return match?.[1] ?? null;
}

export function digestToken(token: string): Uint8Array {
  return new Uint8Array(createHash(DIGEST_ALGORITHM).update(token, "utf8").digest());
}

/**
 * Compares SHA-256 digests so both sides are always 32 bytes — no token-length
 * leak and `timingSafeEqual` can never throw on a mismatched candidate.
 */
export function isAuthorized(req: Request, tokenDigest: Uint8Array): boolean {
  const candidate = bearerToken(req);
  if (candidate === null) {
    return false;
  }
  const candidateDigest = digestToken(candidate);
  if (candidateDigest.byteLength !== tokenDigest.byteLength) {
    return false;
  }
  return timingSafeEqual(candidateDigest, tokenDigest);
}
