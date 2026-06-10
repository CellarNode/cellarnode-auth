import type { AuthUser, SessionClaims, UserType } from "./types.js";

export function validateUserType(user: AuthUser, expected: UserType): boolean {
  return user.userType === expected;
}

/**
 * True if the user/session holds the given entitlement (CEL-599 / Epic A).
 *
 * Accepts an `AuthUser` (from `getMe` / `/auth/me`, where `entitlements` may be
 * absent on older backends) OR a `SessionClaims`-shaped object. Null-safe —
 * returns false for a missing source or a source with no entitlements. Mirrors
 * the `validateUserType` guard shape.
 */
export function hasEntitlement(
  source: AuthUser | SessionClaims | null | undefined,
  entitlement: string,
): boolean {
  return source?.entitlements?.includes(entitlement) ?? false;
}
