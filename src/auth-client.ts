import { AuthError } from "./types.js";
import type { AuthClientConfig, AuthClient, AuthErrorResponse } from "./types.js";

export function createAuthClient(config: AuthClientConfig): AuthClient {
  const { baseUrl, store, onAuthFailure } = config;

  async function parseErrorResponse(
    res: Response,
  ): Promise<AuthErrorResponse> {
    try {
      const body = (await res.json()) as Record<string, unknown>;
      return {
        error:
          typeof body.error === "string" ? body.error : `HTTP ${res.status}`,
        code: typeof body.code === "string" ? body.code : "UNKNOWN",
        remainingAttempts:
          typeof body.remainingAttempts === "number"
            ? body.remainingAttempts
            : undefined,
      };
    } catch {
      return { error: `HTTP ${res.status}`, code: "UNKNOWN" };
    }
  }

  const client: AuthClient = {
    async fetch<T>(
      path: string,
      options?: RequestInit & { skipAuth?: boolean },
    ): Promise<T> {
      const { skipAuth, ...init } = options ?? {};
      const headers = new Headers(init.headers);

      if (!skipAuth) {
        const token = store.getAccessToken();
        if (token) {
          headers.set("Authorization", `Bearer ${token}`);
        }
      }

      if (!headers.has("Content-Type") && init.body) {
        headers.set("Content-Type", "application/json");
      }

      const url = `${baseUrl}${path}`;

      const res = await fetch(url, {
        ...init,
        headers,
        credentials: "include",
      });

      if (res.ok) {
        return (await res.json()) as T;
      }

      // 401: attempt one refresh + retry (only for authenticated requests)
      if (res.status === 401 && !skipAuth) {
        const newToken = await store.ensureAccessToken(true);
        if (newToken) {
          headers.set("Authorization", `Bearer ${newToken}`);
          const retryRes = await fetch(url, {
            ...init,
            headers,
            credentials: "include",
          });
          if (retryRes.ok) {
            return (await retryRes.json()) as T;
          }
        }
        // Refresh failed or retry failed
        store.clearAccessToken();
        onAuthFailure?.();
      }

      const errBody = await parseErrorResponse(res);
      throw new AuthError(
        res.status,
        errBody.code,
        errBody.error,
        errBody.remainingAttempts,
      );
    },
  };

  return client;
}
