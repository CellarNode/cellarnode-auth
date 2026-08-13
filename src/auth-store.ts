import type {
  AccessTokenSetListener,
  AuthStore,
  AuthStoreConfig,
  AuthUser,
  DevLoginFailure,
  DevLoginResult,
  LogoutListener,
  OrgChangeListener,
  SessionUserType,
} from "./types.js";
import { extractAccessToken } from "./extract-token.js";

/**
 * Minimal identity shape cached by the auth-store, sourced from `GET /auth/me`.
 *
 * CEL-622 — the public access token is an opaque, ENCRYPTED JWE (jose
 * `EncryptJWT`, alg `dir` / `A256GCM`). It is NOT client-decodable, so the
 * store can no longer derive identity from the token. Instead, every time a
 * token is acquired or changed, the store fetches `/auth/me` (the authoritative,
 * decryptable endpoint that — post-CEL-630 — returns orgId, userId, userType
 * AND entitlements) with the bearer token and caches the result here.
 */
interface Identity {
  userId: string;
  orgId: string | null;
  userType: SessionUserType;
  entitlements: string[];
}

/**
 * Map a `/auth/me` AuthUser onto the minimal cached identity.
 *
 * `AuthUser.id` is the userId. `entitlements` is optional on the wire (older
 * backends omit it) → defaults to `[]`. The element filter guards against a
 * malformed array carrying non-string entries.
 */
function toIdentity(user: AuthUser): Identity {
  const entitlements = Array.isArray(user.entitlements)
    ? user.entitlements.filter((e): e is string => typeof e === "string")
    : [];
  return {
    userId: user.id,
    orgId: user.orgId ?? null,
    userType: user.userType,
    entitlements,
  };
}

/**
 * Fallback access-token lifetime, in seconds, when the server omits
 * `expiresIn`. Mirrors the verify-otp adoption path in `auth-api.ts`.
 */
const DEFAULT_ACCESS_TOKEN_TTL = 900;

/**
 * Developer-facing copy for each `devLogin()` failure (CEL-1364).
 *
 * The 404 message frames the outcome as "the backend gate is off" and nothing
 * else. The backend deliberately returns an identical 404 for "gate off" and
 * "no such user" (T3-1), so any copy that named the account would be both a
 * guess and a weakening of that contract.
 *
 * These strings SHIP in production bundles — they are referenced from
 * `devLogin`'s live body, which no bundler can prove unreachable. The
 * `ENABLE_TEST_ENDPOINTS` mention is therefore public, which is fine: the flag
 * is documented in this package's README and in the backend repo, and knowing
 * its name grants nothing when the route is not mounted. Moving the copy behind
 * the DEV-only React module would eliminate it, but only by taking the
 * ready-to-render `message` off `DevLoginFailure` — a public-API change, not a
 * review fixup.
 */
const DEV_LOGIN_MESSAGES = {
  "test-endpoints-disabled":
    "Dev sign-in unavailable: backend test endpoints are disabled. Set ENABLE_TEST_ENDPOINTS=true on the API and restart it.",
  "rate-limited": "Dev sign-in rate limit hit (5/min). Wait a minute and retry.",
  forbidden:
    "Dev sign-in rejected: the API requires a fixture secret (TEST_FIXTURE_SECRET is set).",
  network: "Dev sign-in could not reach the API. Is the backend running?",
  "malformed-response":
    "Dev sign-in succeeded but the API returned no access token.",
} as const;

export function createAuthStore(config: AuthStoreConfig): AuthStore {
  const { baseUrl, refreshPath = "/auth/refresh", refreshBuffer = 60 } = config;

  let accessToken: string | null = null;
  let identity: Identity | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshPromise: Promise<string | null> | null = null;

  // Tracks the orgId observed at the last emitted state so `onOrgChange` only
  // fires on an actual transition. `hasEmittedOrgId` disambiguates the two
  // meanings `previousOrgId === null` would otherwise carry — "no org emitted
  // yet" vs "the current org is admin/null". Without it, the FIRST admin
  // identity (orgId null) and an admin login right after `clearToken()` would
  // skip `onOrgChange(null)`. Both are reset on logout so a subsequent login
  // re-fires `onOrgChange` even into the same org.
  let previousOrgId: string | null = null;
  let hasEmittedOrgId = false;

  // Monotonic generation counter. Bumped on every token change (set / clear /
  // refresh). An in-flight `/auth/me` resolution only commits if its captured
  // generation still matches — this discards stale identity results when the
  // token changed again before the previous fetch resolved.
  let tokenGeneration = 0;

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
   * Fetch `/auth/me` with the bearer token and return the parsed identity, or
   * null on any failure (network error, non-2xx, malformed body).
   *
   * Tolerant by design — mirrors how `performRefresh` swallows errors. A failed
   * `/auth/me` must NOT throw out of `setAccessToken` / `performRefresh`; the
   * caller treats null identity as "logged in but identity unknown" and the
   * getters fall back to null/[].
   */
  async function fetchIdentity(token: string): Promise<Identity | null> {
    try {
      const res = await fetch(`${baseUrl}/auth/me`, {
        method: "GET",
        credentials: "include",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      const user = (await res.json()) as AuthUser;
      if (!user || typeof user.id !== "string" || user.id.length === 0) {
        return null;
      }
      return toIdentity(user);
    } catch {
      return null;
    }
  }

  /**
   * Commit a freshly-resolved identity and emit the dependent events.
   *
   * EVENT ORDERING (CRITICAL — consumer realtime hooks depend on it):
   * identity is async, so on a token change the sequence is:
   *   1. set token (synchronous, in `setAccessToken` / `performRefresh`)
   *   2. kick off `fetchIdentity(token)` (async)
   *   3. ON RESOLVE → here:
   *        a. cache identity FIRST (so getters return real values)
   *        b. emit `onAccessTokenSet(token)` (consumer hooks re-read getOrgId()
   *           inside this handler — identity must already be cached)
   *        c. emit `onOrgChange(orgId)` IF orgId actually changed vs the last
   *           emitted state
   *
   * The `generation` guard discards this commit if the token changed again
   * (set/clear/refresh) while this `/auth/me` was in flight.
   */
  function commitIdentity(
    generation: number,
    token: string,
    nextIdentity: Identity | null,
  ): void {
    if (generation !== tokenGeneration) {
      // A newer token change superseded this fetch — drop the stale result.
      return;
    }

    identity = nextIdentity;
    const nextOrgId = nextIdentity?.orgId ?? null;

    // (b) Token-set first — handlers read getOrgId()/getUserId() and must see
    // the just-cached identity.
    emitAccessTokenSet(token);

    // (c) Org-change on the first emission OR an actual transition. The
    // `!hasEmittedOrgId` guard ensures the first identity (incl. an admin
    // orgId of null) always fires once.
    if (!hasEmittedOrgId || nextOrgId !== previousOrgId) {
      hasEmittedOrgId = true;
      previousOrgId = nextOrgId;
      emitOrgChange(nextOrgId);
    }
  }

  /**
   * Apply a new access token, kicking off async identity resolution.
   *
   * The token is committed synchronously (so `getAccessToken()` is immediately
   * correct); identity + `onAccessTokenSet` + `onOrgChange` settle only after
   * `/auth/me` resolves (see `commitIdentity`).
   */
  function applyToken(token: string): void {
    tokenGeneration += 1;
    const generation = tokenGeneration;
    accessToken = token;
    // Clear the prior session's identity synchronously so the getters return
    // the documented null/[] defaults until the fresh /auth/me resolves —
    // otherwise a token switch (e.g. logging in as a different user) would leak
    // the previous session's userId/orgId/entitlements until the new fetch
    // lands. The realtime consumer hooks read the getters on events (not by
    // polling), so this introduces no flicker: a same-user refresh re-commits
    // the same orgId without firing `onOrgChange`.
    identity = null;
    void fetchIdentity(token).then((next) =>
      commitIdentity(generation, token, next),
    );
  }

  /**
   * Clear all token + identity state synchronously and reset org tracking.
   *
   * `onAccessTokenSet(null)` fires synchronously (no `/auth/me` round-trip on
   * logout). `previousOrgId` is reset so a subsequent login re-fires
   * `onOrgChange` even when the user logs back into the same org.
   */
  function clearToken(): void {
    tokenGeneration += 1; // invalidate any in-flight /auth/me
    accessToken = null;
    identity = null;
    previousOrgId = null;
    hasEmittedOrgId = false;
    emitAccessTokenSet(null);
  }

  async function performRefresh(): Promise<string | null> {
    try {
      const res = await fetch(`${baseUrl}${refreshPath}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        clearToken();
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
      clearToken();
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
      clearToken();
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

    /**
     * LOCAL-DEV ONLY (CEL-1364) — see the `AuthStore.devLogin` doc comment.
     *
     * Adoption deliberately routes through `store.setAccessToken()` rather than
     * touching `applyToken` / `scheduleRefresh` directly, so there is exactly
     * ONE token-adoption path shared with verify-otp: same identity fetch, same
     * refresh scheduling, same listener fan-out and ordering.
     */
    async devLogin(email: string): Promise<DevLoginResult> {
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/test/login`, {
          method: "POST",
          // The route also sets the BFF session + refresh cookies the OTP flow
          // sets; `include` is what lets a subsequent `/auth/refresh` work.
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });
      } catch {
        return {
          ok: false,
          reason: "network",
          status: null,
          message: DEV_LOGIN_MESSAGES.network,
        };
      }

      if (!res.ok) {
        if (res.status === 404) {
          return {
            ok: false,
            reason: "test-endpoints-disabled",
            status: 404,
            message: DEV_LOGIN_MESSAGES["test-endpoints-disabled"],
          };
        }
        if (res.status === 429) {
          return {
            ok: false,
            reason: "rate-limited",
            status: 429,
            message: DEV_LOGIN_MESSAGES["rate-limited"],
          };
        }
        if (res.status === 403) {
          return {
            ok: false,
            reason: "forbidden",
            status: 403,
            message: DEV_LOGIN_MESSAGES.forbidden,
          };
        }
        return {
          ok: false,
          reason: "unexpected",
          status: res.status,
          message: `Dev sign-in failed (HTTP ${res.status}).`,
        };
      }

      // Built once: three distinct malformed shapes converge on it below.
      const malformed: DevLoginFailure = {
        ok: false,
        reason: "malformed-response",
        status: res.status,
        message: DEV_LOGIN_MESSAGES["malformed-response"],
      };

      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        return malformed;
      }

      // `res.json()` resolving is not the same as "we got an object". A body of
      // literal `null` (or a bare string/number) parses fine, and
      // `extractAccessToken` dereferences its argument — so passing `null`
      // through would THROW out of a function whose result type promises it
      // never does, leaving the DEV button with no error channel at all.
      // Arrays fall through: they are objects, carry no token, and reach the
      // same `malformed` below.
      if (parsed === null || typeof parsed !== "object") {
        return malformed;
      }
      const json = parsed as Record<string, unknown>;

      const token = extractAccessToken(json);
      if (!token) {
        return malformed;
      }

      const expiresIn =
        typeof json.expiresIn === "number"
          ? json.expiresIn
          : DEFAULT_ACCESS_TOKEN_TTL;

      store.setAccessToken(token, expiresIn);

      return {
        ok: true,
        accessToken: token,
        expiresIn,
        userId: typeof json.userId === "string" ? json.userId : null,
        orgId: typeof json.orgId === "string" ? json.orgId : null,
      };
    },

    getUserId() {
      return identity?.userId ?? null;
    },

    getOrgId() {
      return identity?.orgId ?? null;
    },

    getUserType() {
      return identity?.userType ?? null;
    },

    getEntitlements() {
      // Defensive copy; [] when logged out or identity unresolved.
      return identity ? [...identity.entitlements] : [];
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
