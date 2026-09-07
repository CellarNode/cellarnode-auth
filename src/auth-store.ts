import { copyAuthUser, parseAuthUser } from "./auth-user.js";
import { extractAccessToken } from "./extract-token.js";
import type {
  AccessTokenSetListener,
  AuthStoreConfig,
  AuthUser,
  ConcreteAuthStore,
  DevLoginFailure,
  DevLoginResult,
  LogoutListener,
  OrgChangeListener,
  ResolveSessionOptions,
  SessionResolution,
  SessionState,
  SessionStateListener,
} from "./types.js";

const DEFAULT_ACCESS_TOKEN_TTL = 900;

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

type IdentityRead =
  | { status: "ready"; user: AuthUser }
  | { status: "unavailable" }
  | { status: "unauthorized" };

interface ReadyBaseline {
  token: string;
  user: AuthUser;
}

interface IdentityFlight {
  generation: number;
  promise: Promise<SessionResolution>;
}

interface RefreshFlight {
  generation: number;
  promise: Promise<SessionResolution>;
}

function copySessionState(state: SessionState): SessionState {
  return state.status === "ready"
    ? { ...state, user: copyAuthUser(state.user) }
    : { ...state };
}

function copyResolution(resolution: SessionResolution): SessionResolution {
  return resolution.status === "ready"
    ? { ...resolution, user: copyAuthUser(resolution.user) }
    : { ...resolution };
}

export function createAuthStore(config: AuthStoreConfig): ConcreteAuthStore {
  const { baseUrl, refreshPath = "/auth/refresh", refreshBuffer = 60 } = config;

  let accessToken: string | null = null;
  let identity: AuthUser | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let identityFlight: IdentityFlight | null = null;
  let refreshFlight: RefreshFlight | null = null;
  let tokenGeneration = 0;
  let previousOrgId: string | null = null;
  let hasEmittedOrgId = false;
  // Last validated principal/tenant survives transient authority outages. It
  // never powers authority getters; it only prevents raw same-token identity
  // changes from becoming trusted after an unavailable read.
  let continuityBaseline: ReadyBaseline | null = null;
  // A refreshed credential may be adopted before its identity read succeeds.
  // Preserve its old-principal lineage so a later retry still verifies account
  // continuity while permitting a fresh-token organisation transition.
  let pendingRefreshBaseline: ReadyBaseline | null = null;
  let sessionState: SessionState = { status: "unauthorized" };

  const orgChangeListeners = new Set<OrgChangeListener>();
  const accessTokenSetListeners = new Set<AccessTokenSetListener>();
  const logoutListeners = new Set<LogoutListener>();
  const sessionStateListeners = new Set<SessionStateListener>();
  const stateQueue: SessionState[] = [];
  let publishingState = false;

  function emitOrgChange(orgId: string | null): void {
    for (const listener of orgChangeListeners) {
      try {
        listener(orgId);
      } catch {
        // Subscriber failures cannot break other observers or session adoption.
      }
    }
  }

  function emitAccessTokenSet(token: string | null): void {
    for (const listener of accessTokenSetListeners) {
      try {
        listener(token);
      } catch {
        // Subscriber failures cannot break other observers or session adoption.
      }
    }
  }

  function emitLogout(): void {
    for (const listener of logoutListeners) {
      try {
        listener();
      } catch {
        // Subscriber failures cannot break other observers or logout.
      }
    }
  }

  function publishSessionState(next: SessionState): void {
    stateQueue.push(copySessionState(next));
    if (publishingState) return;
    publishingState = true;
    try {
      while (stateQueue.length > 0) {
        const published = stateQueue.shift();
        if (!published) continue;
        sessionState = published;
        for (const listener of sessionStateListeners) {
          try {
            listener(copySessionState(published));
          } catch {
            // Observers cannot veto or interrupt global session resolution.
          }
        }
      }
    } finally {
      publishingState = false;
    }
  }

  /** Notify consumers before authority or credentials can change. */
  function beginResolving(
    generation: number,
    token: string | null,
  ): boolean {
    publishSessionState({ status: "resolving", token });
    if (generation !== tokenGeneration) return false;
    identity = null;
    return true;
  }

  function scheduleRefresh(expiresInSeconds: number): void {
    if (refreshTimer) clearTimeout(refreshTimer);
    const delay = Math.max((expiresInSeconds - refreshBuffer) * 1000, 0);
    refreshTimer = setTimeout(() => {
      void store.resolveSession({ refresh: true });
    }, delay);
  }

  async function fetchIdentity(token: string): Promise<IdentityRead> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/auth/me`, {
        method: "GET",
        credentials: "include",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      return { status: "unavailable" };
    }

    if (response.status === 401 || response.status === 403) {
      return { status: "unauthorized" };
    }
    if (!response.ok) return { status: "unavailable" };

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      return { status: "unavailable" };
    }

    const user = parseAuthUser(raw);
    return user
      ? { status: "ready", user }
      : { status: "unavailable" };
  }

  function clearCurrentGeneration(generation: number): boolean {
    if (generation !== tokenGeneration) return false;
    tokenGeneration += 1;
    const clearedGeneration = tokenGeneration;
    accessToken = null;
    identity = null;
    continuityBaseline = null;
    pendingRefreshBaseline = null;
    previousOrgId = null;
    hasEmittedOrgId = false;
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    publishSessionState({ status: "unauthorized" });
    if (tokenGeneration === clearedGeneration && accessToken === null) {
      emitAccessTokenSet(null);
    }
    return true;
  }

  function markUnavailable(
    generation: number,
    token: string | null,
  ): SessionResolution {
    if (generation !== tokenGeneration || accessToken !== token) {
      return { status: "superseded" };
    }
    identity = null;
    publishSessionState({ status: "unavailable", token });
    if (generation !== tokenGeneration || accessToken !== token) {
      return { status: "superseded" };
    }
    if (
      token &&
      generation === tokenGeneration &&
      accessToken === token
    ) {
      emitAccessTokenSet(token);
    }
    if (generation !== tokenGeneration || accessToken !== token) {
      return { status: "superseded" };
    }
    return { status: "unavailable", token };
  }

  function commitReady(
    generation: number,
    token: string,
    user: AuthUser,
  ): SessionResolution {
    if (generation !== tokenGeneration || accessToken !== token) {
      return { status: "superseded" };
    }

    identity = copyAuthUser(user);
    const nextOrgId = identity.orgId;
    continuityBaseline = { token, user: copyAuthUser(identity) };
    pendingRefreshBaseline = null;

    publishSessionState({ status: "ready", token, user: identity });
    if (generation !== tokenGeneration || accessToken !== token) {
      return { status: "superseded" };
    }
    emitAccessTokenSet(token);
    if (generation !== tokenGeneration || accessToken !== token) {
      return { status: "superseded" };
    }
    if (!hasEmittedOrgId || nextOrgId !== previousOrgId) {
      hasEmittedOrgId = true;
      previousOrgId = nextOrgId;
      emitOrgChange(nextOrgId);
    }

    if (generation !== tokenGeneration || accessToken !== token) {
      return { status: "superseded" };
    }

    return { status: "ready", token, user: copyAuthUser(identity) };
  }

  function resolveIdentity(
    generation: number,
    token: string,
    baseline: ReadyBaseline | null,
    refreshed: boolean,
  ): Promise<SessionResolution> {
    if (identityFlight?.generation === generation) {
      return identityFlight.promise;
    }

    let flight!: IdentityFlight;
    const promise = (async (): Promise<SessionResolution> => {
      const read = await fetchIdentity(token);
      if (generation !== tokenGeneration || accessToken !== token) {
        return { status: "superseded" };
      }

      if (read.status === "unauthorized") {
        clearCurrentGeneration(generation);
        return { status: "unauthorized" };
      }
      if (read.status === "unavailable") {
        return markUnavailable(generation, token);
      }

      if (baseline && read.user.id !== baseline.user.id) {
        if (!refreshed) return runRefresh(generation, baseline);
        clearCurrentGeneration(generation);
        return { status: "unauthorized" };
      }

      if (baseline && read.user.orgId !== baseline.user.orgId) {
        if (!refreshed) {
          // Same-token raw membership changes are not authority. Rotate once,
          // then validate fresh credentials before adopting the transition.
          return runRefresh(generation, baseline);
        }
        if (token === baseline.token) {
          return markUnavailable(generation, token);
        }
      }

      return commitReady(generation, token, read.user);
    })().finally(() => {
      if (identityFlight === flight) identityFlight = null;
    });

    flight = { generation, promise };
    identityFlight = flight;
    return promise;
  }

  function currentBaseline(): ReadyBaseline | null {
    const baseline = pendingRefreshBaseline ?? continuityBaseline;
    return baseline
      ? { token: baseline.token, user: copyAuthUser(baseline.user) }
      : null;
  }

  function runRefresh(
    generation: number,
    baseline: ReadyBaseline | null,
  ): Promise<SessionResolution> {
    if (refreshFlight?.generation === generation) {
      return refreshFlight.promise;
    }
    if (generation !== tokenGeneration) {
      return Promise.resolve({ status: "superseded" });
    }

    if (!beginResolving(generation, accessToken)) {
      return Promise.resolve({ status: "superseded" });
    }

    let flight!: RefreshFlight;
    const promise = (async (): Promise<SessionResolution> => {
      let response: Response;
      try {
        response = await fetch(`${baseUrl}${refreshPath}`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
        });
      } catch {
        return markUnavailable(generation, accessToken);
      }

      if (generation !== tokenGeneration) return { status: "superseded" };
      if (response.status === 401 || response.status === 403) {
        clearCurrentGeneration(generation);
        return { status: "unauthorized" };
      }
      if (!response.ok) return markUnavailable(generation, accessToken);

      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        return markUnavailable(generation, accessToken);
      }
      if (generation !== tokenGeneration) return { status: "superseded" };
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        return markUnavailable(generation, accessToken);
      }

      const json = raw as Record<string, unknown>;
      const nextToken = extractAccessToken(json);
      if (!nextToken) return markUnavailable(generation, accessToken);

      const expiresIn =
        typeof json.expiresIn === "number" && Number.isFinite(json.expiresIn)
          ? json.expiresIn
          : DEFAULT_ACCESS_TOKEN_TTL;

      tokenGeneration += 1;
      const nextGeneration = tokenGeneration;
      // Manual/timer callers arriving while refreshed identity still resolves
      // join this same end-to-end refresh operation.
      flight.generation = nextGeneration;
      accessToken = nextToken;
      identity = null;
      pendingRefreshBaseline = baseline
        ? { token: baseline.token, user: copyAuthUser(baseline.user) }
        : null;
      scheduleRefresh(expiresIn);

      return resolveIdentity(nextGeneration, nextToken, baseline, true);
    })().finally(() => {
      if (refreshFlight === flight) refreshFlight = null;
    });

    flight = { generation, promise };
    refreshFlight = flight;
    return promise;
  }

  function resolveCurrentSession(): Promise<SessionResolution> {
    const token = accessToken;
    const generation = tokenGeneration;
    if (!token) return Promise.resolve({ status: "unauthorized" });
    if (identityFlight?.generation === generation) {
      return identityFlight.promise;
    }

    const baseline = currentBaseline();
    const refreshed = pendingRefreshBaseline !== null;
    if (!beginResolving(generation, token)) {
      return Promise.resolve({ status: "superseded" });
    }
    return resolveIdentity(generation, token, baseline, refreshed);
  }

  function waitForCaller(
    promise: Promise<SessionResolution>,
    signal?: AbortSignal,
  ): Promise<SessionResolution> {
    if (!signal) return promise.then(copyResolution);
    if (signal.aborted) return Promise.resolve({ status: "superseded" });

    return new Promise((resolve) => {
      const onAbort = () => resolve({ status: "superseded" });
      signal.addEventListener("abort", onAbort, { once: true });
      void promise.then((result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(copyResolution(result));
      });
    });
  }

  function startExplicitToken(token: string, expiresIn: number): void {
    const previousGeneration = tokenGeneration;
    if (!beginResolving(previousGeneration, token)) return;
    tokenGeneration += 1;
    const generation = tokenGeneration;
    accessToken = token;
    identity = null;
    continuityBaseline = null;
    pendingRefreshBaseline = null;
    scheduleRefresh(expiresIn);
    void resolveIdentity(generation, token, null, false);
  }

  let store!: ConcreteAuthStore;
  store = {
    getAccessToken: () => accessToken,
    hasAccessToken: () => accessToken !== null,

    setAccessToken(token, expiresIn) {
      startExplicitToken(token, expiresIn);
    },

    clearAccessToken() {
      clearCurrentGeneration(tokenGeneration);
      emitLogout();
    },

    async ensureAccessToken(forceRefresh = false) {
      if (!forceRefresh && accessToken && identity && !identityFlight) {
        return accessToken;
      }
      const result = forceRefresh
        ? await store.resolveSession({ refresh: true })
        : await store.resolveSession();
      return result.status === "ready" || result.status === "unavailable"
        ? result.token
        : null;
    },

    resolveSession(options: ResolveSessionOptions = {}) {
      const shouldRefresh =
        options.refresh === true ||
        (options.refresh === undefined && accessToken === null);
      const operation = shouldRefresh
        ? runRefresh(tokenGeneration, currentBaseline())
        : resolveCurrentSession();
      return waitForCaller(operation, options.signal);
    },

    async devLogin(email: string): Promise<DevLoginResult> {
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/test/login`, {
          method: "POST",
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

      if (!response.ok) {
        if (response.status === 404) {
          return {
            ok: false,
            reason: "test-endpoints-disabled",
            status: 404,
            message: DEV_LOGIN_MESSAGES["test-endpoints-disabled"],
          };
        }
        if (response.status === 429) {
          return {
            ok: false,
            reason: "rate-limited",
            status: 429,
            message: DEV_LOGIN_MESSAGES["rate-limited"],
          };
        }
        if (response.status === 403) {
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
          status: response.status,
          message: `Dev sign-in failed (HTTP ${response.status}).`,
        };
      }

      const malformed: DevLoginFailure = {
        ok: false,
        reason: "malformed-response",
        status: response.status,
        message: DEV_LOGIN_MESSAGES["malformed-response"],
      };

      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        return malformed;
      }
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        return malformed;
      }

      const json = raw as Record<string, unknown>;
      const token = extractAccessToken(json);
      if (!token) return malformed;

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

    getUserId: () => identity?.id ?? null,
    getOrgId: () => identity?.orgId ?? null,
    getUserType: () => identity?.userType ?? null,
    getEntitlements: () =>
      identity?.entitlements ? [...identity.entitlements] : [],

    onSessionStateChange(listener) {
      sessionStateListeners.add(listener);
      try {
        listener(copySessionState(sessionState));
      } catch {
        // Immediate delivery has the same isolation as later notifications.
      }
      return () => {
        sessionStateListeners.delete(listener);
      };
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
