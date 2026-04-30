export interface AuthUser {
  id: string;
  email: string;
  name: string;
  phone?: string;
  userType: "importer" | "producer" | "admin";
  orgId: string | null;
  roles: string[];
  createdAt: string;
}

export interface RegisterInput {
  name: string;
  email: string;
  phone?: string;
  userType: "importer" | "producer";
}

export interface RequestOtpResponse {
  expiresAt: string;
  resendAvailableAt: string;
}

export interface VerifyOtpResponse {
  accessToken: string;
  expiresIn: number;
  user: AuthUser;
}

export interface AuthErrorResponse {
  error: string;
  code: string;
  remainingAttempts?: number;
}

export class AuthError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly remainingAttempts?: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export interface AuthStoreConfig {
  baseUrl: string;
  refreshPath?: string;
  refreshBuffer?: number;
}

/**
 * userType values carried in the V2 access-token JWT.
 *
 * Mirrors `SessionClaims["userType"]` in cellarnode-backend-v2
 * (`src/middleware/auth.ts`). Kept as a distinct type from `UserType`
 * because the session JWT may also carry `"distributor"` (reserved for
 * future use) whereas the public-facing `UserType` enum currently only
 * advertises importer/producer/admin to consumers.
 */
export type SessionUserType = "importer" | "producer" | "distributor" | "admin";

/**
 * Decoded claims from a V2 access-token JWT.
 *
 * Mirrors the backend `SessionClaims` shape in `cellarnode-backend-v2`
 * (`src/middleware/auth.ts`) — copied locally so consumers do not need
 * to import from the backend. Signature verification still happens
 * server-side; the client-side decode is informational only.
 */
export interface SessionClaims {
  userId: string;
  email: string;
  orgId: string | null;
  roles: string[];
  sessionId: string;
  userType: SessionUserType;
}

export type OrgChangeListener = (orgId: string | null) => void;
export type AccessTokenSetListener = (token: string | null) => void;
export type LogoutListener = () => void;

export interface AuthStore {
  getAccessToken(): string | null;
  hasAccessToken(): boolean;
  setAccessToken(token: string, expiresIn: number): void;
  clearAccessToken(): void;
  ensureAccessToken(forceRefresh?: boolean): Promise<string | null>;

  /** Decoded session claims from the current access token, or null. */
  getSessionClaims(): SessionClaims | null;

  /** userId from the current access token, or null. */
  getUserId(): string | null;

  /** orgId from the current access token, or null. Admin returns null. */
  getOrgId(): string | null;

  /** userType from the current access token, or null. */
  getUserType(): SessionUserType | null;

  /** Subscribe to orgId change events. Returns unsubscribe. */
  onOrgChange(listener: OrgChangeListener): () => void;

  /** Subscribe to access-token (re-)set events. Fires after the token is set. Returns unsubscribe. */
  onAccessTokenSet(listener: AccessTokenSetListener): () => void;

  /** Subscribe to logout events. Returns unsubscribe. */
  onLogout(listener: LogoutListener): () => void;
}

export interface AuthClientConfig {
  baseUrl: string;
  store: AuthStore;
  onAuthFailure?: () => void;
}

export interface AuthClient {
  fetch<T>(path: string, options?: RequestInit & { skipAuth?: boolean }): Promise<T>;
}

export interface AuthApi {
  register(input: RegisterInput): Promise<{ userId: string; message?: string }>;
  requestOtp(email: string): Promise<RequestOtpResponse>;
  verifyOtp(email: string, code: string): Promise<VerifyOtpResponse>;
  logout(): Promise<void>;
  getMe(token?: string): Promise<AuthUser>;
}

export type UserType = "importer" | "producer" | "admin";

export interface DashboardLink {
  userType: UserType;
  label: string;
  url: string;
}
