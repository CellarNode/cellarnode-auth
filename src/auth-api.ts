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
import { parseAuthUser } from "./auth-user.js";

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
      const token = store.getAccessToken();
      await client.fetch<void>("/auth/logout", {
        method: "POST",
        skipAuth: true,
        ...(token
          ? { headers: { Authorization: `Bearer ${token}` } }
          : {}),
      });
    },

    async getMe(token?: string) {
      const currentToken = store.getAccessToken();
      if (store.resolveSession && (!token || token === currentToken)) {
        const resolution = await store.resolveSession({ refresh: false });
        if (resolution.status === "ready") return resolution.user;
        if (resolution.status === "unauthorized") {
          throw new AuthError(401, "UNAUTHORIZED", "Session is unauthorized");
        }
        if (resolution.status === "superseded") {
          throw new AuthError(409, "SESSION_SUPERSEDED", "Session was superseded");
        }
        throw new AuthError(
          503,
          "AUTHORITY_UNAVAILABLE",
          "Session identity is unavailable",
        );
      }

      const raw = token
        ? await client.fetch<unknown>("/auth/me", {
          method: "GET",
          skipAuth: true,
          headers: { Authorization: `Bearer ${token}` },
        })
        : await client.fetch<unknown>("/auth/me", {
            method: "GET",
            skipAuth: true,
            ...(currentToken
              ? { headers: { Authorization: `Bearer ${currentToken}` } }
              : {}),
          });
      const user = parseAuthUser(raw);
      if (!user) {
        throw new AuthError(
          503,
          "AUTHORITY_UNAVAILABLE",
          "Session identity is unavailable",
        );
      }
      return user;
    },
  };
}
