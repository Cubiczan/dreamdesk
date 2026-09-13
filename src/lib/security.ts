import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time equality for secrets, tokens, and passwords.
 * `timingSafeEqual` throws on length mismatch, so encode first and only
 * compare when the buffers are the same size.
 */
export function timingSafeEqualString(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Shared secret / webhook token check.
 * Unset expected secret keeps the existing open-intake behavior.
 */
export function webhookSecretIsValid(provided: string | null, expected: string | undefined): boolean {
  if (!expected) return true;
  if (provided == null) return false;
  return timingSafeEqualString(provided, expected);
}
