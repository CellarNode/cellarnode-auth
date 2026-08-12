export interface AuthUser {
  id: string;
  email: string;
  name: string;
  phone?: string;
  userType: "importer" | "producer" | "admin";
  orgId: string | null;
  roles: string[];
  /**
   * Per-user entitlements (CEL-599 / Epic A). Optional on the `/auth/me` wire
   * shape: present once the backend's `/auth/me` mapper returns it, absent for
   * older backends. Consumers should read it as `user.entitlements ?? []`, or
   * prefer `authStore.getEntitlements()` (decoded from the JWT, always present).
   */
  entitlements?: string[];
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
  /**
   * Per-user entitlements carried in the JWT (CEL-599 / Epic A) — e.g.
   * `"producer-dashboard"`, `"importer-dashboard"`, `"elabel"`. Always an array
   * on the decoded claims (empty if the token predates entitlements or the user
   * holds none); the backend mints them from the `user_entitlements` table.
   */
  entitlements: string[];
}

/**
 * Why a `devLogin()` attempt did not produce a session (CEL-1364).
 *
 * ANTI-ENUMERATION CONTRACT (backend T3-1): `POST /test/login` returns the SAME
 * 404 body whether the test-endpoint gate is off OR the address has no local
 * account. The client therefore CANNOT tell those cases apart, and must not
 * pretend it can — `"test-endpoints-disabled"` is client-side framing of "the
 * gate is off", never "this email does not exist". Never derive account
 * existence from this reason, and never surface it as such in UI copy.
 */
export type DevLoginFailureReason =
  | "test-endpoints-disabled"
  | "rate-limited"
  | "forbidden"
  | "network"
  | "malformed-response"
  | "unexpected";

export interface DevLoginSuccess {
  ok: true;
  accessToken: string;
  expiresIn: number;
  userId: string | null;
  orgId: string | null;
}

export interface DevLoginFailure {
  ok: false;
  reason: DevLoginFailureReason;
  /** HTTP status, or null when the request never completed (network error). */
  status: number | null;
  /** Ready-to-render, developer-facing message. Safe for DEV-only UI. */
  message: string;
}

export type DevLoginResult = DevLoginSuccess | DevLoginFailure;

export type OrgChangeListener = (orgId: string | null) => void;
export type AccessTokenSetListener = (token: string | null) => void;
export type LogoutListener = () => void;

export interface AuthStore {
  getAccessToken(): string | null;
  hasAccessToken(): boolean;
  setAccessToken(token: string, expiresIn: number): void;
  clearAccessToken(): void;
  ensureAccessToken(forceRefresh?: boolean): Promise<string | null>;

  /**
   * LOCAL-DEV ONLY — mint a session for `email` via the backend's
   * `POST /test/login`, bypassing the OTP round-trip (CEL-1364).
   *
   * Adoption is the verify-otp path verbatim: the returned JWE goes through
   * `setAccessToken()`, so identity resolution, the refresh timer, and the
   * `onAccessTokenSet` / `onOrgChange` listeners all fire exactly as they do
   * after a real OTP verification. The backend additionally sets the same
   * refresh cookies as the OTP flow, so `/auth/refresh` works afterwards.
   *
   * Rejects nothing: every outcome is returned as a `DevLoginResult` so the
   * DEV-only UI can render an actionable hint.
   *
   * SAFETY: this is a client of a server-gated route, not a gate of its own.
   * The route only exists when the backend runs with `ENABLE_TEST_ENDPOINTS=true`
   * outside production; otherwise it 404s and this resolves to
   * `{ ok: false, reason: "test-endpoints-disabled" }`.
   *
   * Optional on the interface so custom `AuthStore` implementations (e.g. a
   * mobile secure-store adapter) stay source-compatible. `createAuthStore()`
   * always provides it.
   */
  devLogin?(email: string): Promise<DevLoginResult>;

  /**
   * userId of the current session, or null.
   *
   * CEL-622 — sourced from `GET /auth/me` (the public access token is an opaque
   * encrypted JWE and cannot be decoded client-side). Resolves asynchronously
   * after a token is set/refreshed; reads null until `/auth/me` settles.
   */
  getUserId(): string | null;

  /** orgId of the current session, or null. Admin returns null. Sourced from `/auth/me`. */
  getOrgId(): string | null;

  /** userType of the current session, or null. Sourced from `/auth/me`. */
  getUserType(): SessionUserType | null;

  /**
   * Per-user entitlements for the current session (CEL-599). Always an array —
   * empty when logged out or when `/auth/me` carries none. Sourced from
   * `/auth/me` (CEL-622), so it reflects the authoritative server-side state.
   */
  getEntitlements(): string[];

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
