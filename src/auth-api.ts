import { AuthError } from "./types.js";
import type {
  AuthApi,
  AuthClient,
  AuthStore,
  AuthUser,
  RegisterInput,
  RequestOtpResponse,
  VerifyOtpResponse,
} from "./types.js";
import { extractAccessToken } from "./extract-token.js";

export function createAuthApi(config: {
  client: AuthClient;
  store: AuthStore;
}): AuthApi {
  const { client, store } = config;

  return {
    async register(input: RegisterInput) {
      return client.fetch<{ userId: string; message?: string }>(
        "/auth/register",
        {
          method: "POST",
          skipAuth: true,
          body: JSON.stringify(input),
        },
      );
    },

    async requestOtp(email: string) {
      return client.fetch<RequestOtpResponse>("/auth/request-otp", {
        method: "POST",
        skipAuth: true,
        body: JSON.stringify({ email }),
      });
    },

    async verifyOtp(email: string, code: string) {
      const raw = await client.fetch<Record<string, unknown>>(
        "/auth/verify-otp",
        {
          method: "POST",
          skipAuth: true,
          body: JSON.stringify({ email, code }),
        },
      );

      const token = extractAccessToken(raw);
      if (!token) {
        throw new AuthError(500, "TOKEN_EXTRACTION_FAILED", "No access token found in verify-otp response");
      }

      const expiresIn =
        typeof raw.expiresIn === "number" ? raw.expiresIn : 900;

      store.setAccessToken(token, expiresIn);

      return {
        accessToken: token,
        expiresIn,
        user: raw.user as AuthUser,
      };
    },

    async logout() {
      await client.fetch<void>("/auth/logout", { method: "POST" });
    },

    async getMe(token?: string) {
      if (token) {
        return client.fetch<AuthUser>("/auth/me", {
          method: "GET",
          skipAuth: true,
          headers: { Authorization: `Bearer ${token}` },
        });
      }
      return client.fetch<AuthUser>("/auth/me", { method: "GET" });
    },
  };
}
