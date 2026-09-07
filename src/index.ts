export { createAuthStore } from "./auth-store.js";
export { createAuthClient } from "./auth-client.js";
export { createAuthApi } from "./auth-api.js";
export { validateUserType, hasEntitlement } from "./auth-guard.js";
export { extractAccessToken } from "./extract-token.js";
export {
  captureSessionContinuity,
  canReplaySession,
  resolveSessionForReplay,
} from "./session-continuity.js";

export {
  AuthError,
  type AuthUser,
  type AuthStore,
  type ConcreteAuthStore,
  type AuthStoreConfig,
  type AuthClient,
  type AuthClientConfig,
  type AuthApi,
  type RegisterInput,
  type RequestOtpResponse,
  type VerifyOtpResponse,
  type VerifyOtpUser,
  type AuthErrorResponse,
  type DevLoginResult,
  type DevLoginSuccess,
  type DevLoginFailure,
  type DevLoginFailureReason,
  type UserType,
  type DashboardLink,
  type SessionClaims,
  type SessionUserType,
  type ResolveSessionOptions,
  type SessionResolution,
  type SessionState,
  type SessionStateListener,
  type SessionContinuity,
  type OrgChangeListener,
  type AccessTokenSetListener,
  type LogoutListener,
} from "./types.js";
