export { createAuthStore } from "./auth-store.js";
export { createAuthClient } from "./auth-client.js";
export { createAuthApi } from "./auth-api.js";
export { validateUserType, hasEntitlement } from "./auth-guard.js";
export { extractAccessToken } from "./extract-token.js";

export {
  AuthError,
  type AuthUser,
  type AuthStore,
  type AuthStoreConfig,
  type AuthClient,
  type AuthClientConfig,
  type AuthApi,
  type RegisterInput,
  type RequestOtpResponse,
  type VerifyOtpResponse,
  type AuthErrorResponse,
  type UserType,
  type DashboardLink,
  type SessionClaims,
  type SessionUserType,
  type OrgChangeListener,
  type AccessTokenSetListener,
  type LogoutListener,
} from "./types.js";
