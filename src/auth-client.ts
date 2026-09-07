import { AuthError } from "./types.js";
import type { AuthClientConfig, AuthClient, AuthErrorResponse } from "./types.js";
import {
  canReplaySession,
  captureSessionContinuity,
} from "./session-continuity.js";

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
      const continuity = skipAuth ? null : captureSessionContinuity(store);

      if (!skipAuth) {
        const token = store.getAccessToken();
        if (!continuity) {
          throw token
            ? new AuthError(
                503,
                "SESSION_UNAVAILABLE",
                "Session identity is unavailable",
              )
            : new AuthError(401, "UNAUTHORIZED", "Session is unauthorized");
        }
        headers.set("Authorization", `Bearer ${continuity.token}`);
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

      // 401: refresh once. Replay only when validated user + tenant continuity
      // matches the authority captured before original transport.
      if (res.status === 401 && !skipAuth) {
        if (store.resolveSession) {
          const resolution = await store.resolveSession({
            refresh: true,
            signal: init.signal ?? undefined,
          });
          if (
            resolution.status === "ready" &&
            canReplaySession(continuity, resolution, store)
          ) {
            headers.set("Authorization", `Bearer ${resolution.token}`);
            const retryRes = await fetch(url, {
              ...init,
              headers,
              credentials: "include",
            });
            if (retryRes.ok) return (await retryRes.json()) as T;

            const retryError = await parseErrorResponse(retryRes);
            throw new AuthError(
              retryRes.status,
              retryError.code,
              retryError.error,
              retryError.remainingAttempts,
            );
          }
          if (resolution.status === "unavailable") {
            throw new AuthError(
              503,
              "SESSION_UNAVAILABLE",
              "Session identity is unavailable",
            );
          }
          if (resolution.status === "superseded") {
            if (init.signal?.aborted) {
              throw new DOMException("Request aborted", "AbortError");
            }
            throw new AuthError(
              409,
              "SESSION_SUPERSEDED",
              "Request session was superseded",
            );
          }
          if (resolution.status === "ready") {
            throw new AuthError(
              409,
              "SESSION_CONTINUITY_CHANGED",
              "Request session authority changed",
            );
          }
          onAuthFailure?.();
        } else {
          // Legacy custom stores cannot prove post-refresh continuity.
          store.clearAccessToken();
          onAuthFailure?.();
        }
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
