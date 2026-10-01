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
  SessionEndReason,
  SessionResolution,
  SessionState,
  SessionStateListener,
} from "./types.js";

const DEFAULT_ACCESS_TOKEN_TTL = 900;
const DEFAULT_RESOLUTION_TIMEOUT_MS = 10_000;
/**
 * CEL-2107 — the refresh POST is bounded well below the backend's 10s
 * lost-response grace (`SESSION_FAMILY_GRACE_MS`, measured from `rotatedAt`).
 * If the server committed the rotation but the response is lost, the next
 * presentation of the old cookie must land inside that window, where it is an
 * idempotent duplicate. Outside it, it is `REFRESH_REPLAYED`, which revokes
 * the whole family on every device.
 */
const REFRESH_REQUEST_TIMEOUT_MS = 4_000;
/** Retry delay while a rotation may have committed (inside the commit window). */
const TIMEOUT_RETRY_DELAY_MS = 1_500;
/**
 * CEL-2107 (review P2, family-revocation risk) — how long after the SEND of a
 * refresh that timed out (the server may have committed the rotation and lost
 * the response) this tab may keep presenting the old cookie. The backend
 * accepts a duplicate presentation for 10s from `rotatedAt`, and `rotatedAt`
 * is no earlier than the send, so every presentation before send + 8s lands
 * inside that grace with a 2s margin. After it, presenting the cookie could
 * be `REFRESH_REPLAYED`, which revokes the session family on EVERY device, so
 * the tab fails closed locally instead (see `failClosedUncertain`).
 */
const COMMIT_WINDOW_MS = 8_000;
/**
 * CEL-2124 — id of the refresh that might be lost. The server stores it only
 * when that rotation commits. The probe replays it; it does not rotate.
 */
const REFRESH_ATTEMPT_HEADER = "X-Refresh-Attempt";

/** A resolution request aborted by its own deadline (the server may have committed). */
class ResolutionTimeoutError extends Error {
  constructor() {
    super("Session resolution request timed out");
    this.name = "ResolutionTimeoutError";
  }
}

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

/** CEL-2107 — backoff between background renewal retries after a failure. */
const RENEWAL_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const;
/**
 * CEL-2123 (review P3) — after a refresh fails with a network TypeError while
 * the browser still reports online, watch this long for a late `offline`
 * event (the browser can flip `navigator.onLine` just after the fetch
 * rejects). Kept below the first backoff retry (5s -20% jitter = 4s), so the
 * verdict is in before the next presentation.
 */
const LATE_OFFLINE_WATCH_MS = 2_000;

export function createAuthStore(config: AuthStoreConfig): ConcreteAuthStore {
  const {
    baseUrl,
    fetchImpl,
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

  // Scoping note: localStorage is per APP origin, the refresh cookie per API
  // origin. Tabs of one app share both, which is the case handled here. Two
  // different app origins that talk to the same API (and so share its
  // cookie) do NOT see each other's uncertainty; each still fails closed on
  // its own timeouts, and the backend grace (CEL-2113) is the remaining guard.
  //
  // CEL-2107 (0.20.1) — the commit-window uncertainty is SHARED by every
  // same-origin tab through localStorage: tabs share one refresh cookie jar,
  // so a rotation possibly committed by tab A (lost response) makes tab B's
  // old cookie just as dangerous to present after the grace. Keyed per
  // product family + API ORIGIN (`new URL(baseUrl).origin`, so trailing
  // slashes or paths never split one API into two keys). Timestamps only,
  // never a token. Storage failures fall back to memory for this page.
  const storageOrigin = (() => {
    try {
      return new URL(baseUrl).origin;
    } catch {
      return baseUrl;
    }
  })();
  const storageKeyPrefix = `cellarnode:auth:${productFamily ?? "default"}:${storageOrigin}`;
  const possiblyCommittedKey = `${storageKeyPrefix}:possibly-committed-at`;
  const refreshAttemptKey = `${storageKeyPrefix}:refresh-attempt-id`;
  const refreshSuppressedKey = `${storageKeyPrefix}:refresh-presentation-suppressed`;
  const lastConfirmedRotationKey = `${storageKeyPrefix}:last-confirmed-rotation-at`;
  let memoryPossiblyCommittedAt: number | null = null;
  let memoryRefreshAttemptId: string | null = null;
  let memoryRefreshSuppressed = false;
  let memoryLastConfirmedRotationAt: number | null = null;

  function localStorageOrNull(): Storage | null {
    try {
      return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
      return null; // access itself can throw (sandboxed iframe, privacy mode)
    }
  }

  function readTimestamp(key: string): number | null {
    try {
      const raw = localStorageOrNull()?.getItem(key);
      const at = raw ? Number(raw) : Number.NaN;
      return Number.isFinite(at) ? at : null;
    } catch {
      return null;
    }
  }

  function writeTimestamp(key: string, at: number | null): void {
    try {
      const storage = localStorageOrNull();
      if (at === null) storage?.removeItem(key);
      else storage?.setItem(key, String(at));
    } catch {
      // Quota/security errors: the in-memory value still guards this page.
    }
  }

  /**
   * The send time of a refresh that may have committed server-side (lost
   * response), unless ANY tab has since confirmed a rotation whose request
   * was sent after it: that request presented the jar's cookie after the
   * uncertain send and got a live successor back (a duplicate inside the
   * grace is idempotent), so the jar holds a live cookie again. Read fresh on
   * every use, so another tab's writes apply immediately.
   */
  function currentUncertainty(): number | null {
    const committed = readTimestamp(possiblyCommittedKey) ?? memoryPossiblyCommittedAt;
    if (committed === null) return null;
    const confirmed = Math.max(
      readTimestamp(lastConfirmedRotationKey) ?? Number.NEGATIVE_INFINITY,
      memoryLastConfirmedRotationAt ?? Number.NEGATIVE_INFINITY,
    );
    return confirmed >= committed ? null : committed;
  }

  function readStoredString(key: string): string | null {
    try {
      const raw = localStorageOrNull()?.getItem(key);
      return raw && raw.length > 0 ? raw : null;
    } catch {
      return null;
    }
  }

  function writeStoredString(key: string, value: string | null): void {
    try {
      const storage = localStorageOrNull();
      if (value === null) storage?.removeItem(key);
      else storage?.setItem(key, value);
    } catch {
      // Quota/security errors: the in-memory value still guards this page.
    }
  }

  function recordPossiblyCommitted(sentAt: number, attemptId: string): void {
    if (currentUncertainty() !== null) return; // keep the FIRST (earliest) one
    memoryPossiblyCommittedAt = sentAt;
    memoryRefreshAttemptId = attemptId;
    writeTimestamp(possiblyCommittedKey, sentAt);
    writeStoredString(refreshAttemptKey, attemptId);
  }

  /** Attempt id of the uncertain refresh, or null for a legacy record. */
  function readAttemptId(): string | null {
    if (currentUncertainty() === null) return null;
    return readStoredString(refreshAttemptKey) ?? memoryRefreshAttemptId;
  }

  function refreshPresentationSuppressed(): boolean {
    if (memoryRefreshSuppressed) return true;
    try {
      return localStorageOrNull()?.getItem(refreshSuppressedKey) === "1";
    } catch {
      return memoryRefreshSuppressed;
    }
  }

  /**
   * Probe said revoked or expired. The uncertainty record is gone, so this
   * flag is what stops a later resolve from posting the old cookie.
   */
  function suppressRefreshPresentation(): void {
    memoryRefreshSuppressed = true;
    writeStoredString(refreshSuppressedKey, "1");
  }

  function clearRefreshSuppression(): void {
    memoryRefreshSuppressed = false;
    writeStoredString(refreshSuppressedKey, null);
  }

  /** A live credential was confirmed; `sentAt` is when its request left. */
  function recordConfirmedRotation(sentAt: number): void {
    const committed = readTimestamp(possiblyCommittedKey) ?? memoryPossiblyCommittedAt;
    // A committed time in the future (clock set back) can never be matched by
    // a later send; a confirmed credential supersedes it too.
    if (committed !== null && (sentAt >= committed || committed > Date.now())) clearUncertainty();
    memoryLastConfirmedRotationAt = Math.max(memoryLastConfirmedRotationAt ?? sentAt, sentAt);
    writeTimestamp(
      lastConfirmedRotationKey,
      Math.max(readTimestamp(lastConfirmedRotationKey) ?? sentAt, sentAt),
    );
  }

  function clearUncertainty(): void {
    memoryPossiblyCommittedAt = null;
    memoryRefreshAttemptId = null;
    writeTimestamp(possiblyCommittedKey, null);
    writeStoredString(refreshAttemptKey, null);
  }

  function pastCommitWindow(since: number | null = currentUncertainty()): boolean {
    if (since === null) return false;
    const now = Date.now();
    return now >= since + COMMIT_WINDOW_MS || since > now;
  }

  function newRefreshAttemptId(): string {
    return crypto.randomUUID();
  }

  function refreshProbePath(): string {
    return refreshPath.endsWith("/refresh")
      ? `${refreshPath.slice(0, -"refresh".length)}refresh-probe`
      : "/auth/refresh-probe";
  }

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
  // CEL-2107 — a rotation is owed when the last renewal attempt failed before
  // a new token was adopted (network / 5xx / malformed). Until one succeeds,
  // `revalidateSession()` renews instead of reminting (a remint keeps the old
  // expiry), and a bounded backoff keeps retrying in the background.
  let renewalOwed = false;
  let renewalRetryAttempt = 0;
  // Send time of the first refresh that timed out while no rotation has been
  // confirmed since: the server may have committed it (COMMIT_WINDOW_MS).
  // Deliberately survives a `session-uncertain` fail-closed: only a confirmed
  // rotation or an explicit new credential ends the uncertainty.
  // Persisted (timestamp ONLY, never a token) so a reload inside the window
  // cannot bypass it: a cold resolve after reload must not present the cookie.
  // (the possibly-committed uncertainty lives in shared storage; see
  // currentUncertainty above)
  // Wall-clock expiry of the current access token, when known.
  let accessTokenExpiresAt: number | null = null;

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
      // `confirmedToken` is always the BASELINE token, never the candidate
      // `token` argument — a rotated-but-not-yet-verified token must never
      // be exposed paired with `baseline.user` (CEL-2086 review round 1).
      publishSessionState({
        status: "revalidating",
        confirmedToken: baseline.token,
        user: baseline.user,
      });
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

  function scheduleRefresh(expiresInSeconds: number, confirmedSentAt: number = Date.now()): void {
    if (refreshTimer) clearTimeout(refreshTimer);
    accessTokenExpiresAt = Date.now() + expiresInSeconds * 1000;
    renewalOwed = false;
    renewalRetryAttempt = 0;
    // A rotation was confirmed (or a new credential adopted): record it for
    // every tab; it clears any uncertainty that predates its send.
    recordConfirmedRotation(confirmedSentAt);
    const delay = Math.max((expiresInSeconds - refreshBuffer) * 1000, 0);
    refreshTimer = setTimeout(() => {
      void store.resolveSession({ refresh: true });
    }, delay);
  }

  /**
   * CEL-2107 — a failed renewal used to re-arm nothing: the timer that fired
   * was spent, `revalidateSession()` never reschedules, so the access token
   * simply expired and the next navigation met a 401. Retry the rotation on a
   * bounded backoff while a credential is still held.
   */
  function scheduleRenewalRetry(): void {
    if (accessToken === null) return;
    // One timer slot shared with the scheduled renewal: a retry replaces it
    // and never stacks on top of it.
    if (refreshTimer) clearTimeout(refreshTimer);
    if (currentUncertainty() !== null && browserOffline()) {
      // CEL-2123 — no quick retry while offline (it could only fail, and the
      // window check would then sign the user out mid-outage): resume on
      // the browser's `online` event instead.
      holdUntilOnline();
      return;
    }
    if (currentUncertainty() !== null && !pastCommitWindow()) {
      // A rotation may have committed server-side: while the commit window is
      // open, retry ANY failure (timeout or connection error) quickly, inside
      // the backend grace, where a duplicate returns the committed successor.
      // Not deferred for a hidden tab. Chrome's intensive throttling can
      // still delay this timer (to about once a minute in a hidden tab); when
      // it fires late, `runRefresh`'s window check fails closed instead of
      // presenting the cookie outside the grace.
      renewalRetryAttempt += 1;
      const quick = TIMEOUT_RETRY_DELAY_MS + Math.round(Math.random() * 250);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        if (accessToken !== null && renewalOwed) void store.resolveSession({ refresh: true });
      }, quick);
      return;
    }
    const base =
      RENEWAL_RETRY_DELAYS_MS[
        Math.min(renewalRetryAttempt, RENEWAL_RETRY_DELAYS_MS.length - 1)
      ]!;
    // ±20% jitter: tabs that failed together (one outage, one shared refresh
    // cookie) must not retry in lockstep. Concurrent same-cookie rotations are
    // idempotent server-side within the grace window (CEL-1718/CEL-1867), so
    // this only spreads load; it is not needed for correctness.
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    renewalRetryAttempt += 1;
    refreshTimer = setTimeout(runRenewalRetryWhenVisible, delay);
  }

  /**
   * A hidden (background) tab defers its retry until it is visible again, so
   * N open tabs do not each hammer /auth/refresh during an outage. The
   * visible tab's successful rotation updates the shared refresh cookie; the
   * deferred tab then renews once, on its first return to the foreground.
   */
  function runRenewalRetryWhenVisible(): void {
    refreshTimer = null;
    if (accessToken === null || !renewalOwed) return;
    const doc = typeof document === "undefined" ? null : document;
    if (doc && doc.visibilityState === "hidden") {
      const onVisible = () => {
        if (doc.visibilityState === "hidden") return;
        doc.removeEventListener("visibilitychange", onVisible);
        if (accessToken !== null && renewalOwed && refreshTimer === null) {
          void store.resolveSession({ refresh: true });
        }
      };
      doc.addEventListener("visibilitychange", onVisible);
      return;
    }
    void store.resolveSession({ refresh: true });
  }

  /** A remint cannot extend expiry, so a renewal is due instead. */
  function renewalDue(): boolean {
    if (renewalOwed) return true;
    return (
      accessTokenExpiresAt !== null &&
      Date.now() >= accessTokenExpiresAt - refreshBuffer * 1000
    );
  }

  function withResolutionTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number = requestTimeoutMs,
  ): Promise<T> {
    const controller = new AbortController();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort();
        reject(new ResolutionTimeoutError());
      }, timeoutMs);
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
    timeoutMs: number = requestTimeoutMs,
  ): Promise<{ response: Response; raw: unknown }> {
    return withResolutionTimeout(async (signal) => {
      const response = await fetchAuthRequest(
        baseUrl,
        path,
        {
          ...init,
          signal,
        },
        fetchImpl,
      );
      const raw = response.ok ? await response.json() : null;
      return { response, raw };
    }, timeoutMs);
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

  function clearCurrentGeneration(
    generation: number,
    reason?: SessionEndReason,
  ): boolean {
    if (generation !== tokenGeneration) return false;
    // CEL-2123 — the session this hold was deciding for is over.
    cancelOnlineResume();
    cancelLateOfflineWatch();
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
    renewalOwed = false;
    renewalRetryAttempt = 0;
    // CEL-2107 (0.20.1, P1 in 0.20.0): a LOCAL clear never ends the
    // uncertainty. Every app calls clearAccessToken() right after the
    // session-uncertain bounce; ending it here let the sign-in page's cold
    // refresh present the old cookie minutes later (REPLAYED, every device
    // signed out). Only a confirmed rotation, an explicit new sign-in, or a
    // server-confirmed logout (`endSessionUncertainty`) may end it.
    accessTokenExpiresAt = null;
    publishSessionState(
      reason ? { status: "unauthorized", reason } : { status: "unauthorized" },
    );
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
      // CEL-2107 — a 401 on a read that did NOT just rotate credentials is
      // most often an access token that expired while its renewal could not
      // run (network outage). The refresh cookie is the authority on whether
      // the session still exists: rotate once, and only a refused rotation
      // signs out. A rotation that fails on the network stays `unavailable`
      // instead of tearing down a valid session.
      if (!refreshed && baseline) {
        return runRefresh(generation, baseline);
      }
      return clearCurrentGeneration(generation)
        ? { status: "unauthorized" }
        : { status: "superseded" };
    }
    if (read.status === "unavailable") {
      return markUnavailable(generation, token);
    }

    if (baseline && read.user.id !== baseline.user.id) {
      // User id is bound to the token — unlike an org divergence below,
      // an identity divergence gets NO corroborating re-read, whether this
      // read used the same token as the baseline or an already-rotated one
      // (CEL-2086 review round 1). A second read that happened to report the
      // original user back must not be allowed to resurrect "ready": once
      // the confirmed token's identity has been seen to diverge, the session
      // fails closed immediately. CEL-2107: when the divergent read followed
      // a rotation, the shared refresh cookie now belongs to another account
      // (another tab signed in); say so, so consumers can reload into it.
      return clearCurrentGeneration(
        generation,
        refreshed ? "account-changed" : undefined,
      )
        ? { status: "unauthorized" }
        : { status: "superseded" };
    }

    if (baseline && read.user.orgId !== baseline.user.orgId) {
      if (!refreshed) {
        // Same-token raw membership changes are not authority. Rotate once,
        // then validate fresh credentials before adopting the transition.
        return runRefresh(generation, baseline);
      }
      return confirmOrgDivergence(generation, token, baseline, read.user);
    }

    return commitReady(generation, token, read.user);
  }

  /**
   * A post-rotation identity read that diverges from the last confirmed
   * baseline's `orgId` (same user id) is re-checked once more with an
   * independent `/auth/me` read on the SAME token before it is trusted. A
   * rotated token always differs from the baseline's, so — unlike the
   * same-token raw-mismatch case above — a single divergent read here has no
   * second signal to corroborate it: it could be a genuine org change, or a
   * transient backend inconsistency right after rotation (replication lag, a
   * cache still keyed off the old membership) surfacing on a routine
   * scheduled renewal with no real change involved at all (CEL-2086,
   * producer `orgId: null` report). Only a divergence that repeats on the
   * follow-up read is adopted; a one-off is discarded in favor of the
   * baseline, and two reads that disagree with each other AND the baseline
   * suspend rather than guess. A user-id change surfacing on this
   * confirming read gets the same no-corroboration treatment as the branch
   * above — it exists only to corroborate an ORG divergence.
   */
  async function confirmOrgDivergence(
    generation: number,
    token: string,
    baseline: ReadyBaseline,
    firstRead: AuthUser,
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
    if (confirmed.id !== baseline.user.id) {
      // Only reached after a rotation (see confirmOrgDivergence's caller).
      return clearCurrentGeneration(generation, "account-changed")
        ? { status: "unauthorized" }
        : { status: "superseded" };
    }

    if (confirmed.orgId === baseline.user.orgId) {
      // The divergence did not repeat — commit the corroborating read and
      // keep continuity with the previously confirmed identity.
      return commitReady(generation, token, confirmed);
    }

    if (confirmed.orgId === firstRead.orgId) {
      // Same org divergence twice in a row: a genuine org change.
      return commitReady(generation, token, confirmed);
    }

    // Neither read agrees with the other nor with the baseline on org —
    // the org source is unstable. Don't guess; suspend rather than adopt.
    return markUnavailable(generation, token);
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

  /**
   * CEL-2107 — this tab can no longer tell whether its refresh cookie was
   * rotated (a lost response outside the commit window). Drop the local
   * credential and publish `unauthorized` with reason `session-uncertain`, so
   * the app shows sign-in. Signing this one tab in again is far better than
   * REFRESH_REPLAYED revoking every device in the family.
   */
  /**
   * CEL-2123 — true when the browser reports no network. Used ONLY to hold a
   * possibly-committed rotation undecided; never as proof that a timed-out
   * request was not delivered (that would risk REFRESH_REPLAYED revoking the
   * family on every device).
   */
  function browserOffline(): boolean {
    return typeof navigator !== "undefined" && navigator.onLine === false;
  }

  let onlineResume: (() => void) | null = null;
  /** A possibly-committed rotation is held undecided until `online`. */
  let holdOwed = false;
  /** The next refresh is the reconnect decision: probe before presenting. */
  let reconnectDecision = false;
  /**
   * CEL-2123 — while offline with a possibly-committed rotation, the tab can
   * neither confirm nor safely present the refresh cookie, and signing the
   * user out mid-outage is the wrong answer. Wait for the browser's `online`
   * event, then decide once: back inside the commit window it re-presents
   * (the backend grace makes that idempotent); past it, it fails closed.
   */
  function holdUntilOnline(): void {
    holdOwed = true;
    if (onlineResume) return;
    const target = typeof window === "undefined" ? null : window;
    if (!target || typeof target.addEventListener !== "function") return;
    onlineResume = () => {
      target.removeEventListener("online", onlineResume!);
      onlineResume = null;
      // Keyed off the owed decision, not the in-memory token, so a cold hold
      // (a reload offline inside the uncertainty) also decides. A sign-out or
      // a new sign-in clears it first (cancelOnlineResume).
      if (!holdOwed) return;
      holdOwed = false;
      reconnectDecision = true;
      void store.resolveSession({ refresh: true });
    };
    target.addEventListener("online", onlineResume);
  }

  let lateOfflineWatch: (() => void) | null = null;
  /**
   * CEL-2123 (review P3) — a network TypeError while still online may be the
   * first sign of a drop the browser has not reported yet. If `offline` fires
   * within LATE_OFFLINE_WATCH_MS, treat the request like one that failed
   * offline: it may have committed, so record it and hold.
   */
  function watchForLateOffline(
    sentAt: number,
    attemptId: string,
    generation: number,
  ): void {
    cancelLateOfflineWatch();
    const target = typeof window === "undefined" ? null : window;
    if (!target || typeof target.addEventListener !== "function") return;
    const onOffline = () => {
      cancelLateOfflineWatch();
      // A newer session owns the timers and the uncertainty record now.
      if (generation !== tokenGeneration) return;
      recordPossiblyCommitted(sentAt, attemptId);
      // The pending backoff retry would only fail offline; hold instead.
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      renewalOwed = true;
      holdUntilOnline();
    };
    const timer = setTimeout(cancelLateOfflineWatch, LATE_OFFLINE_WATCH_MS);
    target.addEventListener("offline", onOffline);
    lateOfflineWatch = () => {
      clearTimeout(timer);
      target.removeEventListener("offline", onOffline);
    };
  }

  function cancelLateOfflineWatch(): void {
    if (!lateOfflineWatch) return;
    const cancel = lateOfflineWatch;
    lateOfflineWatch = null;
    cancel();
  }

  /** A new session or a sign-out owes no decision on the old rotation. */
  function cancelOnlineResume(): void {
    holdOwed = false;
    reconnectDecision = false;
    if (!onlineResume) return;
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("online", onlineResume);
    }
    onlineResume = null;
  }

  type ProbeOutcome =
    | "committed"
    | "not-committed"
    | "revoked"
    | "expired"
    | "inconclusive";

  function readProbeOutcome(raw: unknown): ProbeOutcome | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const status = (raw as Record<string, unknown>).status;
    if (
      status === "committed" ||
      status === "not-committed" ||
      status === "revoked" ||
      status === "expired"
    ) {
      return status;
    }
    return null;
  }

  /**
   * CEL-2124 — ask whether the lost refresh committed. The probe presents the
   * old cookie and the attempt id; it does not rotate and does not move
   * `rotatedAt`. A transport failure is inconclusive: do not guess.
   */
  async function probeRefreshAttempt(attemptId: string): Promise<ProbeOutcome> {
    try {
      const { response, raw } = await withResolutionTimeout(async (signal) => {
        const response = await fetchAuthRequest(
          baseUrl,
          refreshProbePath(),
          {
            method: "POST",
            credentials: "include",
            signal,
            headers: {
              "Content-Type": "application/json",
              [REFRESH_ATTEMPT_HEADER]: attemptId,
              ...(productFamily
                ? { [SESSION_FAMILY_HEADER]: productFamily }
                : {}),
            },
          },
          fetchImpl,
        );
        let body: unknown = null;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        return { response, raw: body };
      }, Math.min(requestTimeoutMs, REFRESH_REQUEST_TIMEOUT_MS));
      if (response.status === 429) return "inconclusive";
      // The attempt id is stored only when rotation commits. A 401 for that
      // id means the lost refresh did not commit, so the old cookie is still
      // safe to present. Any other 401 stays inconclusive.
      if (response.status === 401 && readErrorCode(raw) === "INVALID_REFRESH_ATTEMPT") {
        return "not-committed";
      }
      return readProbeOutcome(raw) ?? "inconclusive";
    } catch {
      return "inconclusive";
    }
  }

  function failClosedUncertain(): SessionResolution {
    renewalOwed = false;
    if (accessToken === null) {
      // No local credential (e.g. a reload inside the uncertainty): nothing to
      // clear, but still say why, so the app shows sign-in.
      publishSessionState({ status: "unauthorized", reason: "session-uncertain" });
      return { status: "unauthorized" };
    }
    return clearCurrentGeneration(tokenGeneration, "session-uncertain")
      ? { status: "unauthorized" }
      : { status: "superseded" };
  }

  function runRefresh(
    generation: number,
    baseline: ReadyBaseline | null,
  ): Promise<SessionResolution> {
    if (refreshFlight) return refreshFlight.promise;
    if (generation !== tokenGeneration) {
      return Promise.resolve({ status: "superseded" });
    }
    // CEL-2107 — the ONLY place the refresh cookie is presented. Once the
    // commit window of a possibly-committed rotation has passed, never
    // present it again (backoff, "Try again", read-401 fallback and a cold
    // resolve all come through here) unless the probe says that presentation
    // is safe. A revoked or expired probe, or a legacy record with no attempt
    // id, fails closed locally instead of risking REFRESH_REPLAYED.
    if (refreshPresentationSuppressed()) {
      reconnectDecision = false;
      return Promise.resolve(failClosedUncertain());
    }
    const uncertainSince = currentUncertainty();
    // CEL-2123 — offline with a possibly-committed rotation: never present
    // the cookie and never fail closed while the outage lasts. Stay
    // `unavailable` and decide once the browser is back online.
    if (uncertainSince !== null && browserOffline()) {
      renewalOwed = true;
      holdUntilOnline();
      return Promise.resolve(markUnavailable(generation, accessToken));
    }
    // A committed time in the FUTURE (the clock was set back) cannot be
    // trusted to still be inside the grace: treat it as expired.
    const pastWindow = pastCommitWindow(uncertainSince);
    const storedAttemptId = readAttemptId();
    const shouldProbe =
      storedAttemptId !== null && (pastWindow || reconnectDecision);
    if (pastWindow && !shouldProbe) {
      reconnectDecision = false;
      return Promise.resolve(failClosedUncertain());
    }

    // Expiry renewal / forced refresh wins over an in-flight authority remint.
    authorityFlight = null;

    if (!baseline && identityFlight?.generation === generation) {
      if (!shouldProbe) reconnectDecision = false;
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

    // CEL-2107 — a failure before a new token is adopted leaves the rotation
    // owed (see `renewalOwed`); the retry is scheduled once the flight settles.
    const failRenewal = (): SessionResolution => {
      if (refreshGeneration === tokenGeneration) renewalOwed = true;
      return markUnavailable(refreshGeneration, accessToken);
    };

    // CEL-2123 — a new send supersedes the previous refresh's late-offline
    // watch: it can never record for an already-resolved refresh.
    cancelLateOfflineWatch();
    reconnectDecision = false;
    void (async (): Promise<SessionResolution> => {
      if (shouldProbe && storedAttemptId) {
        const outcome = await probeRefreshAttempt(storedAttemptId);
        if (refreshGeneration !== tokenGeneration) return { status: "superseded" };
        if (outcome === "revoked" || outcome === "expired") {
          // The server confirmed this cookie must not be posted to refresh.
          store.endSessionUncertainty?.();
          suppressRefreshPresentation();
          renewalOwed = false;
          return clearCurrentGeneration(refreshGeneration, "session-uncertain")
            ? { status: "unauthorized" }
            : { status: "superseded" };
        }
        if (outcome === "committed" || outcome === "not-committed") {
          // Committed: the probe re-set the successor. Not committed: the
          // original refresh is safe to retry. Either way the old uncertainty
          // is decided, so the refresh below is an ordinary presentation.
          clearUncertainty();
        } else if (pastWindow) {
          // Inconclusive past the window: do not present, do not sign out.
          return failRenewal();
        }
      }

      const refreshAttemptId = readAttemptId() ?? newRefreshAttemptId();
      const refreshSentAt = Date.now();
      // CEL-2123 (review P2) — whether the browser had a network at send time.
      const onlineAtSend = !browserOffline();
      let result: { response: Response; raw: unknown };
      try {
        result = await fetchResolutionResponse(
          refreshPath,
          {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            [REFRESH_ATTEMPT_HEADER]: refreshAttemptId,
            // CEL-1722: family declaration routes the server to this family's
            // scoped refresh cookie (legacy `refresh_token` stays the read
            // fallback) and opts the request into the bounded lost-response
            // grace window. Family-less stores send no header — legacy wire.
            ...(productFamily
              ? { [SESSION_FAMILY_HEADER]: productFamily }
              : {}),
          },
          },
          Math.min(requestTimeoutMs, REFRESH_REQUEST_TIMEOUT_MS),
        );
      } catch (error) {
        if (error instanceof ResolutionTimeoutError) {
          recordPossiblyCommitted(refreshSentAt, refreshAttemptId);
        } else if (error instanceof TypeError && onlineAtSend && browserOffline()) {
          // CEL-2123 (review P2) — the network dropped while this refresh was
          // in flight. The server may have committed the rotation before the
          // connection died, so this is the same ambiguity as a timeout and
          // the offline hold covers it. A TypeError when the device was
          // ALREADY offline at send stays "not delivered" (it never left).
          recordPossiblyCommitted(refreshSentAt, refreshAttemptId);
        } else if (
          error instanceof TypeError &&
          onlineAtSend &&
          refreshGeneration === tokenGeneration
        ) {
          // CEL-2123 (review P3) — still online at catch: the browser may
          // report the drop a moment later. A superseded refresh (a newer
          // sign-in or send took over) never starts a watch.
          watchForLateOffline(refreshSentAt, refreshAttemptId, refreshGeneration);
        }
        return failRenewal();
      }

      const { response, raw } = result;
      if (refreshGeneration !== tokenGeneration) return { status: "superseded" };
      if (response.status === 401 || response.status === 403) {
        return clearCurrentGeneration(refreshGeneration)
          ? { status: "unauthorized" }
          : { status: "superseded" };
      }
      if (!response.ok) return failRenewal();

      if (refreshGeneration !== tokenGeneration) return { status: "superseded" };
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        return failRenewal();
      }

      const json = raw as Record<string, unknown>;
      const nextToken = extractAccessToken(json);
      if (!nextToken) return failRenewal();

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
      // Confirmed rotation: clears (for every tab) any uncertainty older than
      // this request's send.
      cancelLateOfflineWatch();
      scheduleRefresh(expiresIn, refreshSentAt);

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
        if (result.status === "unavailable" && renewalOwed) scheduleRenewalRetry();
        settle(result);
      },
      () => {
        if (refreshFlight === flight) refreshFlight = null;
        const result = failRenewal();
        if (result.status === "unavailable") scheduleRenewalRetry();
        settle(result);
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
          const response = await fetchAuthRequest(
            baseUrl,
            revalidatePath,
            {
              method: "POST",
              credentials: "omit",
              headers: {
                Authorization: `Bearer ${bearerToken}`,
                "Content-Type": "application/json",
              },
              signal,
            },
            fetchImpl,
          );
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
    // An explicit sign-in (OTP/dev login) issues a brand-new refresh cookie:
    // it always supersedes any uncertainty, whatever its timestamp says.
    clearUncertainty();
    clearRefreshSuppression();
    // CEL-2123 — and any held decision about the old cookie.
    cancelOnlineResume();
    cancelLateOfflineWatch();
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

    endSessionUncertainty() {
      // Only after the SERVER confirmed the session is gone (logout /
      // revoke-all succeeded): the old cookie can no longer be replayed.
      clearUncertainty();
    },

    revalidateSession(options: RevalidateSessionOptions = {}) {
      const operation = explicitAdoptionFlight
        ? explicitAdoptionFlight.promise
        : refreshFlight
          ? refreshFlight.promise
          : authorityFlight
            ? authorityFlight.promise
            : // CEL-2107 — a remint keeps the old expiry; when a renewal is
              // owed (the last one failed) or due, rotate instead so a
              // "Try again" actually restores a lasting session.
              accessToken !== null && renewalDue()
              ? runRefresh(tokenGeneration, currentBaseline())
              : runRevalidate(tokenGeneration);
      return waitForCaller(operation, options.signal);
    },

    async devLogin(email: string): Promise<DevLoginResult> {
      let response: Response;
      try {
        response = await fetchAuthRequest(
          baseUrl,
          "/test/login",
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email }),
          },
          fetchImpl,
        );
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
