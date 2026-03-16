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

export interface AuthStore {
  getAccessToken(): string | null;
  hasAccessToken(): boolean;
  setAccessToken(token: string, expiresIn: number): void;
  clearAccessToken(): void;
  ensureAccessToken(forceRefresh?: boolean): Promise<string | null>;
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
