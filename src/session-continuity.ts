import type {
  AuthStore,
  ResolveSessionOptions,
  SessionContinuity,
  SessionResolution,
} from "./types.js";

/** Capture validated user/tenant authority before request transport begins. */
export function captureSessionContinuity(
  store: AuthStore,
): SessionContinuity | null {
  if (
    typeof store.getUserId !== "function" ||
    typeof store.getOrgId !== "function"
  ) {
    return null;
  }
  const state = store.getSessionState?.();
  if (state && state.status !== "ready") return null;
  const token = store.getAccessToken();
  const userId = store.getUserId();
  const orgId = store.getOrgId();
  if (
    !token ||
    !userId ||
    (state?.status === "ready" &&
      (state.token !== token ||
        state.user.id !== userId ||
        state.user.orgId !== orgId))
  ) {
    return null;
  }
  return { token, userId, orgId };
}

/** Permit 401 replay only across same validated user and organisation. */
export function canReplaySession(
  before: SessionContinuity | null,
  after: SessionResolution,
  store: AuthStore,
): boolean {
  const current = captureSessionContinuity(store);
  return (
    before !== null &&
    after.status === "ready" &&
    current !== null &&
    current.token === after.token &&
    current.userId === after.user.id &&
    current.orgId === after.user.orgId &&
    after.user.id === before.userId &&
    after.user.orgId === before.orgId
  );
}

/**
 * Resolve authority for a 401 retry. Reuse an already-ready replacement only
 * when its user and organisation match the captured authority; otherwise a
 * matching captured credential refreshes. Call `canReplaySession` again
 * immediately before transport.
 */
export async function resolveSessionForReplay(
  store: AuthStore,
  before: SessionContinuity | null,
  options: Pick<ResolveSessionOptions, "signal"> = {},
): Promise<SessionResolution> {
  if (!before) return { status: "superseded" };

  const currentToken = store.getAccessToken();
  const currentState = store.getSessionState?.();
  const current = captureSessionContinuity(store);

  if (currentToken !== before.token) {
    if (
      current &&
      currentState?.status === "ready" &&
      current.token === currentState.token &&
      current.userId === before.userId &&
      current.orgId === before.orgId
    ) {
      return {
        status: "ready",
        token: currentState.token,
        user: currentState.user,
      };
    }
    return { status: "superseded" };
  }

  if (
    currentState?.status === "unauthorized" ||
    ((currentState?.status === "resolving" ||
      currentState?.status === "unavailable") &&
      currentState.token !== before.token) ||
    (currentState?.status === "ready" &&
      (!current ||
        current.userId !== before.userId ||
        current.orgId !== before.orgId))
  ) {
    return { status: "superseded" };
  }

  if (!store.resolveSession) return { status: "superseded" };
  const resolution = await store.resolveSession({
    refresh: true,
    signal: options.signal,
  });
  if (resolution.status === "superseded") return resolution;
  if (resolution.status === "unauthorized") {
    const unauthorizedState = store.getSessionState?.();
    return store.getAccessToken() === null &&
      (unauthorizedState === undefined ||
        unauthorizedState.status === "unauthorized")
      ? resolution
      : { status: "superseded" };
  }
  if (resolution.status === "unavailable") {
    const unavailableState = store.getSessionState?.();
    return store.getAccessToken() === resolution.token &&
      (unavailableState === undefined ||
        ((unavailableState.status === "unavailable" ||
          unavailableState.status === "resolving") &&
          unavailableState.token === resolution.token))
      ? resolution
      : { status: "superseded" };
  }
  if (canReplaySession(before, resolution, store)) return resolution;

  const afterState = store.getSessionState?.();
  if (
    (afterState?.status === "resolving" ||
      afterState?.status === "unavailable") &&
    afterState.token === resolution.token
  ) {
    return { status: "unavailable", token: resolution.token };
  }
  return { status: "superseded" };
}
