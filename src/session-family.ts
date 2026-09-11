/**
 * Session families — client half of CEL-1722 (backend PR
 * cellarnode-backend-v2#709, contract CEL-1718 §3).
 *
 * Producer and e-label dashboards run independent `@cellarnode/auth` stores
 * against the same public API in one browser. A *session family* partitions
 * each product's refresh-token chain so the two can coexist:
 *
 *   - The client declares its family at login (`productFamily` in the
 *     `/auth/verify-otp` and `/auth/registration/session` bodies) and on
 *     every refresh (`X-CellarNode-Family` header).
 *   - The server delivers refresh cookies under family-scoped names
 *     (`cn_rt_producer` / `cn_rt_elabel`); the legacy shared `refresh_token`
 *     cookie remains the read fallback, so pre-upgrade sessions — and
 *     family-less (importer) clients — keep working unchanged.
 *   - Replay revocation is scoped to `userId` AND family server-side, and a
 *     family-declared lost-response retry gets a bounded idempotent-rotate
 *     grace window. The header declaration is what opts a client into both.
 *
 * A family is a session-partition key only — never a permission. Entitlements
 * are still enforced per user by the backend.
 */

/** The two concurrent product families. Importer/admin sessions stay family-less. */
export const SESSION_FAMILIES = ["producer", "elabel"] as const;

export type SessionFamily = (typeof SESSION_FAMILIES)[number];

export function isSessionFamily(value: unknown): value is SessionFamily {
  return value === "producer" || value === "elabel";
}

/** Request header a family-aware client declares on refresh (CEL-1722). */
export const SESSION_FAMILY_HEADER = "X-CellarNode-Family";

/** Shared cookie name used before session families existed (and by importer). */
export const LEGACY_REFRESH_COOKIE_NAME = "refresh_token";

const FAMILY_COOKIE_NAMES: Record<SessionFamily, string> = {
  producer: "cn_rt_producer",
  elabel: "cn_rt_elabel",
};

/**
 * Cookie name the server delivers a refresh token under for the given family.
 * The cookies are HttpOnly — clients never read or write them directly; this
 * mapping exists for diagnostics, tests, and consumer documentation.
 */
export function refreshCookieNameFor(
  family: SessionFamily | null | undefined,
): string {
  return family ? FAMILY_COOKIE_NAMES[family] : LEGACY_REFRESH_COOKIE_NAME;
}

/**
 * Merge a declared `productFamily` field into a login/registration body.
 *
 * Family-less (`undefined`) keeps the wire shape EXACTLY as before — the
 * backend treats an absent field as a legacy/importer client. Consumers that
 * call `/auth/registration/session` directly (this package does not wrap it)
 * should spread this helper into their body.
 */
export function withProductFamily<T extends object>(
  body: T,
  productFamily: SessionFamily | null | undefined,
): T & { productFamily?: SessionFamily } {
  return productFamily ? { ...body, productFamily } : { ...body };
}
