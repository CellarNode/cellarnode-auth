import { copyAuthUser, parseAuthUser } from "./auth-user.js";
import { extractAccessToken } from "./extract-token.js";
import { fetchAuthRequest } from "./auth-transport.js";
import { SESSION_FAMILY_HEADER } from "./session-family.js";
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
  RevalidateSessionOptions,
  SessionResolution,
  SessionState,
  SessionStateListener,
} from "./types.js";

const DEFAULT_ACCESS_TOKEN_TTL = 900;
const DEFAULT_RESOLUTION_TIMEOUT_MS = 10_000;

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

interface AuthorityFlight {
  generation: number;
  promise: Promise<SessionResolution>;
}

interface ExplicitAdoptionFlight {
  generation: number;
  promise: Promise<SessionResolution>;
  settle: (resolution: SessionResolution) => void;
}

function copySessionState(state: SessionState): SessionState {
  return state.status === "ready" || state.status === "revalidating"
    ? { ...state, user: copyAuthUser(state.user) }
    : { ...state };
}

function copyResolution(resolution: SessionResolution): SessionResolution {
  return resolution.status === "ready"
    ? { ...resolution, user: copyAuthUser(resolution.user) }
    : { ...resolution };
}

export function createAuthStore(config: AuthStoreConfig): ConcreteAuthStore {
  const {
    baseUrl,
    refreshPath = "/auth/refresh",
    revalidatePath = "/auth/revalidate",
    refreshBuffer = 60,
    resolutionTimeoutMs = DEFAULT_RESOLUTION_TIMEOUT_MS,
    productFamily = null,
  } = config;
  const requestTimeoutMs =
    Number.isFinite(resolutionTimeoutMs) && resolutionTimeoutMs > 0
      ? resolutionTimeoutMs
      : DEFAULT_RESOLUTION_TIMEOUT_MS;

  let accessToken: string | null = null;
  let identity: AuthUser | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let identityFlight: IdentityFlight | null = null;
  let refreshFlight: RefreshFlight | null = null;
  let authorityFlight: AuthorityFlight | null = null;
  let explicitAdoptionFlight: ExplicitAdoptionFlight | null = null;
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

  function settleExplicitGeneration(
    generation: number,
    resolution: SessionResolution,
  ): void {
    if (explicitAdoptionFlight?.generation === generation) {
      explicitAdoptionFlight.settle(resolution);
    }
  }

  function emitOrgChange(
    orgId: string | null,
    shouldContinue: () => boolean = () => true,
  ): void {
    for (const listener of orgChangeListeners) {
      try {
        listener(orgId);
      } catch {
        // Subscriber failures cannot break other observers or session adoption.
      }
      if (!shouldContinue()) break;
    }
  }

  function emitAccessTokenSet(
    token: string | null,
    shouldContinue: () => boolean = () => true,
  ): void {
    for (const listener of accessTokenSetListeners) {
      try {
        listener(token);
      } catch {
        // Subscriber failures cannot break other observers or session adoption.
      }
      if (!shouldContinue()) break;
    }
  }

  function emitLogout(
    shouldContinue: () => boolean = () => true,
  ): void {
    for (const listener of logoutListeners) {
      try {
        listener();
      } catch {
        // Subscriber failures cannot break other observers or logout.
      }
      if (!shouldContinue()) break;
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
          const queuedBeforeCallback = stateQueue.length;
          try {
            listener(copySessionState(published));
          } catch {
            // Observers cannot veto or interrupt global session resolution.
          }
          if (stateQueue.length > queuedBeforeCallback) break;
        }
      }
    } finally {
      publishingState = false;
    }
  }

  /**
   * Publish `revalidating` (carrying the last confirmed token/user) when a
   * confirmed baseline exists and the caller has not lost its token entirely;
   * otherwise publish plain `resolving` (CEL-2086). `identity`/getters are
   * NOT touched here — only the published SessionState distinguishes the two,
   * so `getUserId()`/`getOrgId()`/`ensureAccessToken()` keep their existing
   * "unknown until this operation settles" contract either way.
   */
  function publishResolvingOrRevalidating(
    token: string | null,
    baseline: ReadyBaseline | null,
  ): void {
    if (baseline && token !== null) {
      publishSessionState({ status: "revalidating", token, user: baseline.user });
    } else {
      publishSessionState({ status: "resolving", token });
    }
  }

  /**
   * Notify consumers before authority or credentials can change. `baseline`
   * is the confirmed identity this operation may end up reconfirming — pass
   * it for background refresh/revalidation so consumers see `revalidating`
   * instead of `resolving` (CEL-2086). Omit it (or pass null) for an explicit
   * new-credential adoption, which never has continuity with a prior session.
   */
  function beginResolving(
    generation: number,
    token: string | null,
    baseline: ReadyBaseline | null = null,
  ): boolean {
    publishResolvingOrRevalidating(token, baseline);
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

  function withResolutionTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Session resolution request timed out"));
      }, requestTimeoutMs);
      let pending: Promise<T>;
      try {
        pending = operation(controller.signal);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
        return;
      }
      void pending.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  function fetchResolutionResponse(
    path: string,
    init: RequestInit,
  ): Promise<{ response: Response; raw: unknown }> {
    return withResolutionTimeout(async (signal) => {
      const response = await fetchAuthRequest(baseUrl, path, {
        ...init,
        signal,
      });
      const raw = response.ok ? await response.json() : null;
      return { response, raw };
    });
  }

  async function fetchIdentity(token: string): Promise<IdentityRead> {
    let result: { response: Response; raw: unknown };
    try {
      result = await fetchResolutionResponse("/auth/me", {
        method: "GET",
        credentials: "include",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      return { status: "unavailable" };
    }

    const { response, raw } = result;
    if (response.status === 401 || response.status === 403) {
      return { status: "unauthorized" };
    }
    if (!response.ok) return { status: "unavailable" };

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
    identityFlight = null;
    refreshFlight = null;
    authorityFlight = null;
    previousOrgId = null;
    hasEmittedOrgId = false;
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    publishSessionState({ status: "unauthorized" });
    if (tokenGeneration !== clearedGeneration || accessToken !== null) return false;
    emitAccessTokenSet(
      null,
      () => tokenGeneration === clearedGeneration && accessToken === null,
    );
    const cleared =
      tokenGeneration === clearedGeneration && accessToken === null;
    if (cleared) {
      settleExplicitGeneration(generation, { status: "unauthorized" });
    }
    return cleared;
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
    const result: SessionResolution = { status: "unavailable", token };
    settleExplicitGeneration(generation, result);
    return result;
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
    emitAccessTokenSet(
      token,
      () => generation === tokenGeneration && accessToken === token,
    );
    if (generation !== tokenGeneration || accessToken !== token) {
      return { status: "superseded" };
    }
    if (!hasEmittedOrgId || nextOrgId !== previousOrgId) {
      hasEmittedOrgId = true;
      previousOrgId = nextOrgId;
      emitOrgChange(
        nextOrgId,
        () => generation === tokenGeneration && accessToken === token,
      );
    }

    if (generation !== tokenGeneration || accessToken !== token) {
      return { status: "superseded" };
    }

    const result: SessionResolution = {
      status: "ready",
      token,
      user: copyAuthUser(identity),
    };
    settleExplicitGeneration(generation, result);
    return result;
  }

  async function evaluateIdentity(
    generation: number,
    token: string,
    baseline: ReadyBaseline | null,
    refreshed: boolean,
  ): Promise<SessionResolution> {
    const read = await fetchIdentity(token);
    if (generation !== tokenGeneration || accessToken !== token) {
      return { status: "superseded" };
    }

    if (read.status === "unauthorized") {
      return clearCurrentGeneration(generation)
        ? { status: "unauthorized" }
        : { status: "superseded" };
    }
    if (read.status === "unavailable") {
      return markUnavailable(generation, token);
    }

    if (baseline && read.user.id !== baseline.user.id) {
      if (!refreshed) return runRefresh(generation, baseline);
      return confirmAuthorityDivergence(generation, token, baseline, read.user, "identity");
    }

    if (baseline && read.user.orgId !== baseline.user.orgId) {
      if (!refreshed) {
        // Same-token raw membership changes are not authority. Rotate once,
        // then validate fresh credentials before adopting the transition.
        return runRefresh(generation, baseline);
      }
      return confirmAuthorityDivergence(generation, token, baseline, read.user, "org");
    }

    return commitReady(generation, token, read.user);
  }

  /**
   * A post-rotation identity read that diverges from the last confirmed
   * baseline (a different user id, or the same user with a different orgId)
   * is re-checked once more with an independent `/auth/me` read on the SAME
   * token before it is trusted. A rotated token always differs from the
   * baseline's, so — unlike the same-token raw-mismatch case above — a single
   * divergent read here has no second signal to corroborate it: it could be a
   * genuine account/org change, or a transient backend inconsistency right
   * after rotation (replication lag, a cache still keyed off the old
   * membership) surfacing on a routine scheduled renewal with no real change
   * involved at all (CEL-2086, producer `orgId: null` report). Only a
   * divergence that repeats on the follow-up read is adopted or escalated; a
   * one-off is discarded in favor of the baseline, and two reads that
   * disagree with each other AND the baseline suspend rather than guess.
   */
  async function confirmAuthorityDivergence(
    generation: number,
    token: string,
    baseline: ReadyBaseline,
    firstRead: AuthUser,
    kind: "identity" | "org",
  ): Promise<SessionResolution> {
    const confirmation = await fetchIdentity(token);
    if (generation !== tokenGeneration || accessToken !== token) {
      return { status: "superseded" };
    }
    if (confirmation.status === "unauthorized") {
      return clearCurrentGeneration(generation)
        ? { status: "unauthorized" }
        : { status: "superseded" };
    }
    if (confirmation.status === "unavailable") {
      return markUnavailable(generation, token);
    }

    const confirmed = confirmation.user;
    if (confirmed.id === baseline.user.id && confirmed.orgId === baseline.user.orgId) {
      // The divergence did not repeat — commit the corroborating read and
      // keep continuity with the previously confirmed identity.
      return commitReady(generation, token, confirmed);
    }

    const repeatsFirstRead =
      confirmed.id === firstRead.id && confirmed.orgId === firstRead.orgId;

    if (!repeatsFirstRead) {
      // Neither read agrees with the other nor with the baseline — the
      // identity source is unstable. Don't adopt or discard, suspend.
      return markUnavailable(generation, token);
    }

    if (kind === "identity") {
      return clearCurrentGeneration(generation)
        ? { status: "unauthorized" }
        : { status: "superseded" };
    }

    return commitReady(generation, token, confirmed);
  }

  function startIdentityFlight(
    generation: number,
    token: string,
    baseline: ReadyBaseline | null,
    refreshed: boolean,
    notifyResolving: boolean,
  ): Promise<SessionResolution> {
    if (identityFlight?.generation === generation) {
      return identityFlight.promise;
    }

    let settle!: (resolution: SessionResolution) => void;
    const promise = new Promise<SessionResolution>((resolve) => {
      settle = resolve;
    });
    const flight: IdentityFlight = { generation, promise };
    identityFlight = flight;

    if (notifyResolving && !beginResolving(generation, token, baseline)) {
      if (identityFlight === flight) identityFlight = null;
      settle({ status: "superseded" });
      return promise;
    }

    void evaluateIdentity(generation, token, baseline, refreshed).then(
      (result) => {
        if (identityFlight === flight) identityFlight = null;
        settle(result);
      },
      () => {
        if (identityFlight === flight) identityFlight = null;
        settle(markUnavailable(generation, token));
      },
    );
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
    if (refreshFlight) return refreshFlight.promise;
    if (generation !== tokenGeneration) {
      return Promise.resolve({ status: "superseded" });
    }

    // Expiry renewal / forced refresh wins over an in-flight authority remint.
    authorityFlight = null;

    if (!baseline && identityFlight?.generation === generation) {
      const pendingIdentity = identityFlight.promise;
      return pendingIdentity.then((result) => {
        if (result.status === "ready") {
          return runRefresh(tokenGeneration, {
            token: result.token,
            user: copyAuthUser(result.user),
          });
        }
        if (
          result.status === "unavailable" &&
          generation === tokenGeneration &&
          accessToken !== null
        ) {
          return runRefresh(tokenGeneration, null);
        }
        return result;
      });
    }

    let settle!: (resolution: SessionResolution) => void;
    const promise = new Promise<SessionResolution>((resolve) => {
      settle = resolve;
    });
    const flight: RefreshFlight = { generation, promise };
    refreshFlight = flight;

    if (!beginResolving(generation, accessToken, baseline)) {
      if (refreshFlight === flight) refreshFlight = null;
      settle({ status: "superseded" });
      return promise;
    }

    // Refresh owns a new operation generation before transport begins. Any
    // older identity read can no longer publish authority while refresh waits.
    tokenGeneration += 1;
    const refreshGeneration = tokenGeneration;
    flight.generation = refreshGeneration;

    void (async (): Promise<SessionResolution> => {
      let result: { response: Response; raw: unknown };
      try {
        result = await fetchResolutionResponse(refreshPath, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            // CEL-1722: family declaration routes the server to this family's
            // scoped refresh cookie (legacy `refresh_token` stays the read
            // fallback) and opts the request into the bounded lost-response
            // grace window. Family-less stores send no header — legacy wire.
            ...(productFamily
              ? { [SESSION_FAMILY_HEADER]: productFamily }
              : {}),
          },
        });
      } catch {
        return markUnavailable(refreshGeneration, accessToken);
      }

      const { response, raw } = result;
      if (refreshGeneration !== tokenGeneration) return { status: "superseded" };
      if (response.status === 401 || response.status === 403) {
        return clearCurrentGeneration(refreshGeneration)
          ? { status: "unauthorized" }
          : { status: "superseded" };
      }
      if (!response.ok) return markUnavailable(refreshGeneration, accessToken);

      if (refreshGeneration !== tokenGeneration) return { status: "superseded" };
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        return markUnavailable(refreshGeneration, accessToken);
      }

      const json = raw as Record<string, unknown>;
      const nextToken = extractAccessToken(json);
      if (!nextToken) return markUnavailable(refreshGeneration, accessToken);

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
      publishResolvingOrRevalidating(nextToken, baseline);
      if (
        nextGeneration !== tokenGeneration ||
        accessToken !== nextToken
      ) {
        return { status: "superseded" };
      }
      scheduleRefresh(expiresIn);

      return startIdentityFlight(
        nextGeneration,
        nextToken,
        baseline,
        true,
        false,
      );
    })().then(
      (result) => {
        if (refreshFlight === flight) refreshFlight = null;
        settle(result);
      },
      () => {
        if (refreshFlight === flight) refreshFlight = null;
        settle(markUnavailable(refreshGeneration, accessToken));
      },
    );
    return promise;
  }

  function readErrorCode(raw: unknown): string | undefined {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const code = (raw as Record<string, unknown>).code;
    return typeof code === "string" ? code : undefined;
  }

  /**
   * Non-rotating authority remint (CEL-1853). Preserves the absolute refresh
   * deadline/timer — never calls scheduleRefresh with a fresh TTL.
   */
  function runRevalidate(generation: number): Promise<SessionResolution> {
    if (authorityFlight) return authorityFlight.promise;
    if (refreshFlight) return refreshFlight.promise;
    if (explicitAdoptionFlight) return explicitAdoptionFlight.promise;
    if (generation !== tokenGeneration) {
      return Promise.resolve({ status: "superseded" });
    }

    const bearerToken = accessToken;
    if (!bearerToken) return Promise.resolve({ status: "unauthorized" });

    let settle!: (resolution: SessionResolution) => void;
    const promise = new Promise<SessionResolution>((resolve) => {
      settle = resolve;
    });
    const flight: AuthorityFlight = { generation, promise };
    authorityFlight = flight;

    // Captured before beginResolving publishes, so a background remint of an
    // already-confirmed session shows `revalidating` instead of `resolving`
    // (CEL-2086) — this op is a re-check of that identity, never a new one.
    const baseline = currentBaseline();

    if (!beginResolving(generation, bearerToken, baseline)) {
      if (authorityFlight === flight) authorityFlight = null;
      settle({ status: "superseded" });
      return promise;
    }

    // Reserve a generation before POST so earlier /me reads cannot publish.
    tokenGeneration += 1;
    const opGeneration = tokenGeneration;
    flight.generation = opGeneration;

    void (async (): Promise<SessionResolution> => {
      let result: { response: Response; raw: unknown };
      try {
        result = await withResolutionTimeout(async (signal) => {
          const response = await fetchAuthRequest(baseUrl, revalidatePath, {
            method: "POST",
            credentials: "omit",
            headers: {
              Authorization: `Bearer ${bearerToken}`,
              "Content-Type": "application/json",
            },
            signal,
          });
          let raw: unknown = null;
          try {
            raw = await response.json();
          } catch {
            raw = null;
          }
          return { response, raw };
        });
      } catch {
        return markUnavailable(opGeneration, accessToken);
      }

      if (opGeneration !== tokenGeneration) return { status: "superseded" };

      const { response, raw } = result;
      const errorCode = readErrorCode(raw);

      if (response.status === 401 || response.status === 403) {
        // Exactly one expiry-classified fallback to ordinary refresh.
        if (errorCode === "ACCESS_TOKEN_EXPIRED") {
          if (authorityFlight === flight) authorityFlight = null;
          return runRefresh(tokenGeneration, baseline);
        }
        if (opGeneration !== tokenGeneration || accessToken !== bearerToken) {
          return { status: "superseded" };
        }
        return clearCurrentGeneration(opGeneration)
          ? { status: "unauthorized" }
          : { status: "superseded" };
      }

      if (!response.ok) return markUnavailable(opGeneration, accessToken);
      if (opGeneration !== tokenGeneration) return { status: "superseded" };
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        return markUnavailable(opGeneration, accessToken);
      }

      const nextToken = extractAccessToken(raw as Record<string, unknown>);
      if (!nextToken) return markUnavailable(opGeneration, accessToken);

      tokenGeneration += 1;
      const nextGeneration = tokenGeneration;
      flight.generation = nextGeneration;
      accessToken = nextToken;
      identity = null;
      // Reminted credential: retain prior baseline for continuity, allow org
      // transition after /me (refreshed=true). Do NOT reschedule refresh.
      pendingRefreshBaseline = baseline
        ? { token: baseline.token, user: copyAuthUser(baseline.user) }
        : null;
      publishResolvingOrRevalidating(nextToken, baseline);
      if (nextGeneration !== tokenGeneration || accessToken !== nextToken) {
        return { status: "superseded" };
      }

      return startIdentityFlight(
        nextGeneration,
        nextToken,
        baseline,
        true,
        false,
      );
    })().then(
      (result) => {
        if (authorityFlight === flight) authorityFlight = null;
        settle(result);
      },
      () => {
        if (authorityFlight === flight) authorityFlight = null;
        settle(markUnavailable(opGeneration, accessToken));
      },
    );
    return promise;
  }

  function resolveCurrentSession(): Promise<SessionResolution> {
    const token = accessToken;
    const generation = tokenGeneration;
    if (!token) return Promise.resolve({ status: "unauthorized" });
    if (authorityFlight) return authorityFlight.promise;
    if (identityFlight?.generation === generation) {
      return identityFlight.promise;
    }

    const baseline = currentBaseline();
    const refreshed = pendingRefreshBaseline !== null;
    return startIdentityFlight(generation, token, baseline, refreshed, true);
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

  function supersedeExplicitAdoption(): void {
    const flight = explicitAdoptionFlight;
    if (!flight) return;
    explicitAdoptionFlight = null;
    flight.settle({ status: "superseded" });
  }

  function startExplicitToken(token: string, expiresIn: number): void {
    tokenGeneration += 1;
    const generation = tokenGeneration;
    supersedeExplicitAdoption();
    refreshFlight = null;
    authorityFlight = null;

    let settled = false;
    let resolveFlight!: (resolution: SessionResolution) => void;
    const promise = new Promise<SessionResolution>((resolve) => {
      resolveFlight = resolve;
    });
    const flight: ExplicitAdoptionFlight = {
      generation,
      promise,
      settle(resolution) {
        if (settled) return;
        settled = true;
        if (explicitAdoptionFlight === flight) explicitAdoptionFlight = null;
        resolveFlight(resolution);
      },
    };
    explicitAdoptionFlight = flight;

    if (!beginResolving(generation, token)) {
      flight.settle({ status: "superseded" });
      return;
    }
    accessToken = token;
    identity = null;
    continuityBaseline = null;
    pendingRefreshBaseline = null;
    scheduleRefresh(expiresIn);
    void startIdentityFlight(generation, token, null, false, false).then(
      flight.settle,
      () => flight.settle(markUnavailable(generation, token)),
    );
  }

  let store!: ConcreteAuthStore;
  store = {
    getAccessToken: () => accessToken,
    hasAccessToken: () => accessToken !== null,

    setAccessToken(token, expiresIn) {
      startExplicitToken(token, expiresIn);
    },

    clearAccessToken() {
      supersedeExplicitAdoption();
      if (clearCurrentGeneration(tokenGeneration)) {
        const clearedGeneration = tokenGeneration;
        emitLogout(
          () =>
            tokenGeneration === clearedGeneration && accessToken === null,
        );
      }
    },

    async ensureAccessToken(forceRefresh = false) {
      if (
        !forceRefresh &&
        accessToken &&
        identity &&
        !identityFlight &&
        !refreshFlight &&
        !authorityFlight &&
        sessionState.status === "ready"
      ) {
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
      const operation = explicitAdoptionFlight
        ? explicitAdoptionFlight.promise
        : refreshFlight
          ? refreshFlight.promise
          : shouldRefresh
            ? runRefresh(tokenGeneration, currentBaseline())
            : authorityFlight
              ? authorityFlight.promise
              : resolveCurrentSession();
      return waitForCaller(operation, options.signal);
    },

    revalidateSession(options: RevalidateSessionOptions = {}) {
      const operation = explicitAdoptionFlight
        ? explicitAdoptionFlight.promise
        : refreshFlight
          ? refreshFlight.promise
          : authorityFlight
            ? authorityFlight.promise
            : runRevalidate(tokenGeneration);
      return waitForCaller(operation, options.signal);
    },

    async devLogin(email: string): Promise<DevLoginResult> {
      let response: Response;
      try {
        response = await fetchAuthRequest(baseUrl, "/test/login", {
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

    getProductFamily: () => productFamily,

    getUserId: () => identity?.id ?? null,
    getOrgId: () => identity?.orgId ?? null,
    getUserType: () => identity?.userType ?? null,
    getEntitlements: () =>
      identity?.entitlements ? [...identity.entitlements] : [],

    getSessionState: () => copySessionState(sessionState),

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
