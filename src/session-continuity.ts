import type {
  AuthStore,
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
  const token = store.getAccessToken();
  const userId = store.getUserId();
  if (!token || !userId) return null;
  return { token, userId, orgId: store.getOrgId() };
}

/** Permit 401 replay only across same validated user and organisation. */
export function canReplaySession(
  before: SessionContinuity | null,
  after: SessionResolution,
  store: AuthStore,
): boolean {
  return (
    before !== null &&
    after.status === "ready" &&
    store.getAccessToken() === after.token &&
    store.getUserId() === after.user.id &&
    store.getOrgId() === after.user.orgId &&
    after.user.id === before.userId &&
    after.user.orgId === before.orgId
  );
}
