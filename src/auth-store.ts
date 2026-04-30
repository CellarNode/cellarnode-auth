import { decodeJwt } from "jose";
import type {
  AccessTokenSetListener,
  AuthStore,
  AuthStoreConfig,
  LogoutListener,
  OrgChangeListener,
  SessionClaims,
  SessionUserType,
} from "./types.js";
import { extractAccessToken } from "./extract-token.js";

const VALID_USER_TYPES: ReadonlySet<SessionUserType> = new Set([
  "importer",
  "producer",
  "distributor",
  "admin",
]);

/**
 * Decode a JWT payload into SessionClaims.
 *
 * Returns null on any decode failure or if required fields are missing /
 * mistyped. Signature verification is intentionally NOT performed — that
 * is the backend's job at the next authenticated request. This decode is
 * informational only (used for clientId / orgId / userType lookups in the
 * UI layer).
 */
function decodeSessionClaims(token: string): SessionClaims | null {
  let payload: Record<string, unknown>;
  try {
    payload = decodeJwt(token) as Record<string, unknown>;
  } catch {
    return null;
  }

  const userId = payload.userId;
  const email = payload.email;
  const sessionId = payload.sessionId;
  const orgIdRaw = payload.orgId;
  const rolesRaw = payload.roles;
  const userTypeRaw = payload.userType;

  if (typeof userId !== "string" || userId.length === 0) return null;
  if (typeof email !== "string") return null;
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;

  const orgId =
    orgIdRaw === null || orgIdRaw === undefined
      ? null
      : typeof orgIdRaw === "string"
        ? orgIdRaw
        : null;

  const roles = Array.isArray(rolesRaw)
    ? rolesRaw.filter((r): r is string => typeof r === "string")
    : [];

  if (typeof userTypeRaw !== "string") return null;
  if (!VALID_USER_TYPES.has(userTypeRaw as SessionUserType)) return null;

  return {
    userId,
    email,
    orgId,
    roles,
    sessionId,
    userType: userTypeRaw as SessionUserType,
  };
}

export function createAuthStore(config: AuthStoreConfig): AuthStore {
  const { baseUrl, refreshPath = "/auth/refresh", refreshBuffer = 60 } = config;

  let accessToken: string | null = null;
  let claims: SessionClaims | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshPromise: Promise<string | null> | null = null;

  const orgChangeListeners = new Set<OrgChangeListener>();
  const accessTokenSetListeners = new Set<AccessTokenSetListener>();
  const logoutListeners = new Set<LogoutListener>();

  function emitOrgChange(orgId: string | null): void {
    for (const listener of orgChangeListeners) {
      try {
        listener(orgId);
      } catch {
        // Swallow listener errors so a single bad subscriber cannot
        // break event fan-out to other subscribers.
      }
    }
  }

  function emitAccessTokenSet(token: string | null): void {
    for (const listener of accessTokenSetListeners) {
      try {
        listener(token);
      } catch {
        // Swallow.
      }
    }
  }

  function emitLogout(): void {
    for (const listener of logoutListeners) {
      try {
        listener();
      } catch {
        // Swallow.
      }
    }
  }

  function scheduleRefresh(expiresInSeconds: number): void {
    if (refreshTimer) clearTimeout(refreshTimer);
    const delay = Math.max((expiresInSeconds - refreshBuffer) * 1000, 0);
    refreshTimer = setTimeout(() => {
      performRefresh();
    }, delay);
  }

  /**
   * Apply a new access-token value to internal state.
   *
   * - Decodes the JWT via `jose.decodeJwt` (no signature verify).
   * - Caches the decoded claims.
   * - Fires `onOrgChange` listeners ONLY when `orgId` actually changes
   *   (no-op on a same-orgId refresh).
   * - Always fires `onAccessTokenSet` listeners after the token + claims
   *   are committed.
   *
   * Malformed JWTs are tolerated: claims become `null` and `onOrgChange`
   * fires with `null` only if the previous orgId was non-null (i.e. the
   * effective orgId transitioned).
   */
  function applyToken(token: string | null): void {
    const previousOrgId = claims?.orgId ?? null;

    accessToken = token;
    claims = token ? decodeSessionClaims(token) : null;

    const nextOrgId = claims?.orgId ?? null;

    if (nextOrgId !== previousOrgId) {
      emitOrgChange(nextOrgId);
    }

    emitAccessTokenSet(token);
  }

  async function performRefresh(): Promise<string | null> {
    try {
      const res = await fetch(`${baseUrl}${refreshPath}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        applyToken(null);
        return null;
      }
      const json = (await res.json()) as Record<string, unknown>;
      const token = extractAccessToken(json);
      if (token) {
        const expiresIn =
          typeof json.expiresIn === "number" ? json.expiresIn : 900;
        applyToken(token);
        scheduleRefresh(expiresIn);
      }
      return token;
    } catch {
      applyToken(null);
      return null;
    }
  }

  const store: AuthStore = {
    getAccessToken() {
      return accessToken;
    },

    hasAccessToken() {
      return accessToken !== null;
    },

    setAccessToken(token: string, expiresIn: number) {
      applyToken(token);
      scheduleRefresh(expiresIn);
    },

    clearAccessToken() {
      applyToken(null);
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      // Emits unconditionally so consumers can rely on `onLogout` as a
      // canonical logout signal regardless of prior token state.
      emitLogout();
    },

    async ensureAccessToken(forceRefresh = false) {
      if (!forceRefresh && accessToken) return accessToken;
      if (refreshPromise) return refreshPromise;
      refreshPromise = performRefresh().finally(() => {
        refreshPromise = null;
      });
      return refreshPromise;
    },

    getSessionClaims() {
      // Return a defensive copy so external callers cannot mutate the
      // internal claims object (e.g. push to roles, reassign userType).
      return claims
        ? { ...claims, roles: [...claims.roles] }
        : null;
    },

    getUserId() {
      return claims?.userId ?? null;
    },

    getOrgId() {
      return claims?.orgId ?? null;
    },

    getUserType() {
      return claims?.userType ?? null;
    },

    onOrgChange(listener) {
      orgChangeListeners.add(listener);
      return () => {
        orgChangeListeners.delete(listener);
      };
    },

    onAccessTokenSet(listener) {
      accessTokenSetListeners.add(listener);
      return () => {
        accessTokenSetListeners.delete(listener);
      };
    },

    onLogout(listener) {
      logoutListeners.add(listener);
      return () => {
        logoutListeners.delete(listener);
      };
    },
  };

  return store;
}
