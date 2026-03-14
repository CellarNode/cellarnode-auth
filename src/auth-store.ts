import type { AuthStoreConfig, AuthStore } from "./types.js";
import { extractAccessToken } from "./extract-token.js";

export function createAuthStore(config: AuthStoreConfig): AuthStore {
  const { baseUrl, refreshPath = "/auth/refresh", refreshBuffer = 60 } = config;

  let accessToken: string | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshPromise: Promise<string | null> | null = null;

  function scheduleRefresh(expiresInSeconds: number): void {
    if (refreshTimer) clearTimeout(refreshTimer);
    const delay = Math.max((expiresInSeconds - refreshBuffer) * 1000, 0);
    refreshTimer = setTimeout(() => {
      performRefresh();
    }, delay);
  }

  async function performRefresh(): Promise<string | null> {
    try {
      const res = await fetch(`${baseUrl}${refreshPath}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        accessToken = null;
        return null;
      }
      const json = (await res.json()) as Record<string, unknown>;
      const token = extractAccessToken(json);
      if (token) {
        const expiresIn =
          typeof json.expiresIn === "number" ? json.expiresIn : 900;
        accessToken = token;
        scheduleRefresh(expiresIn);
      }
      return token;
    } catch {
      accessToken = null;
      return null;
    }
  }

  const store: AuthStore = {
    getAccessToken() {
      return accessToken;
    },

    hasAccessToken() {
      return accessToken !== null;
    },

    setAccessToken(token: string, expiresIn: number) {
      accessToken = token;
      scheduleRefresh(expiresIn);
    },

    clearAccessToken() {
      accessToken = null;
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
    },

    async ensureAccessToken(forceRefresh = false) {
      if (!forceRefresh && accessToken) return accessToken;
      if (refreshPromise) return refreshPromise;
      refreshPromise = performRefresh().finally(() => {
        refreshPromise = null;
      });
      return refreshPromise;
    },
  };

  return store;
}
