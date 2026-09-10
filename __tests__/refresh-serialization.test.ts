import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAuthStore } from "../src/auth-store.js";
import type { AuthUser } from "../src/types.js";

/**
 * CEL-1721 — serialize scheduled and forced customer-token refresh.
 *
 * The audit found that the refresh timer called `performRefresh` directly,
 * bypassing the `refreshPromise` single-flight that `ensureAccessToken`
 * uses. Triggering the timer and then forcing `ensureAccessToken(true)`
 * before the first response landed sent TWO `/auth/refresh` requests —
 * and since backend replay-detection revokes the refresh session on the
 * second (replayed) use of the shared cookie, the user got logged out.
 *
 * These tests drive the real `createAuthStore` interface with an
 * intercepted `global.fetch`, using deferred refresh responses so the
 * overlap window is deterministic.
 */

const baseMe: AuthUser = {
  id: "user_123",
  email: "alice@example.com",
  name: "Alice",
  userType: "importer",
  orgId: "org_1",
  roles: ["member"],
  entitlements: ["producer-dashboard", "elabel"],
  createdAt: "2024-01-01T00:00:00.000Z",
};

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  };
}

/** A /auth/refresh response the test resolves manually (deferred). */
interface DeferredRefresh {
  resolve: (token: string | null, ok?: boolean) => void;
  promise: Promise<unknown>;
}

function makeDeferredRefresh(): DeferredRefresh {
  let resolveFetch!: (r: unknown) => void;
  const promise = new Promise<unknown>((r) => {
    resolveFetch = r;
  });
  return {
    promise,
    resolve: (token, ok = true) => {
      resolveFetch(
        token == null
          ? jsonResponse({ error: "invalid" }, false, 401)
          : jsonResponse({ accessToken: token, expiresIn: 900 }, ok),
      );
    },
  };
}

/** fetch mock: /auth/me always succeeds; /auth/refresh is fully manual. */
function deferredFetch() {
  const deferred: DeferredRefresh[] = [];
  const mockFetch = vi.fn((url: string) => {
    if (typeof url === "string" && url.includes("/auth/me")) {
      return Promise.resolve(jsonResponse(baseMe));
    }
    if (typeof url === "string" && url.includes("/auth/refresh")) {
      const d = makeDeferredRefresh();
      deferred.push(d);
      return d.promise;
    }
    return Promise.resolve(jsonResponse({}, false, 404));
  });
  return { mockFetch, deferred };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function refreshCalls(mockFetch: ReturnType<typeof deferredFetch>["mockFetch"]) {
  return mockFetch.mock.calls.filter(
    (c) => !String(c[0]).includes("/auth/me"),
  );
}

describe("createAuthStore — refresh serialization (CEL-1721)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("timer + forced ensureAccessToken overlap sends exactly ONE /auth/refresh", async () => {
    const { mockFetch, deferred } = deferredFetch();
    global.fetch = mockFetch as unknown as typeof fetch;

    const store = createAuthStore({
      baseUrl: "http://localhost:4000",
      refreshBuffer: 60,
    });
    store.setAccessToken("tok_initial", 120); // timer fires at t=60s
    await flush();

    // 1. Scheduled refresh fires — response deliberately hangs.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshCalls(mockFetch)).toHaveLength(1);

    // 2. Forced refresh (401-retry / bootstrap path) lands BEFORE the
    //    scheduled response resolves. Must join the in-flight request,
    //    not start a second one.
    const forced = store.ensureAccessToken(true);
    await flush();
    expect(refreshCalls(mockFetch)).toHaveLength(1);

    // 3. The single shared response satisfies both callers.
    deferred[0].resolve("tok_refreshed");
    await expect(forced).resolves.toBe("tok_refreshed");
    expect(store.getAccessToken()).toBe("tok_refreshed");
  });

  it("forced + non-forced concurrent ensure callers share one result", async () => {
    const { mockFetch, deferred } = deferredFetch();
    global.fetch = mockFetch as unknown as typeof fetch;

    const store = createAuthStore({ baseUrl: "http://localhost:4000" });

    const forced = store.ensureAccessToken(true);
    const plain = store.ensureAccessToken();
    const alsoForced = store.ensureAccessToken(true);
    await flush();

    expect(refreshCalls(mockFetch)).toHaveLength(1);
    deferred[0].resolve("tok_a");
    await expect(forced).resolves.toBe("tok_a");
    await expect(plain).resolves.toBe("tok_a");
    await expect(alsoForced).resolves.toBe("tok_a");
  });

  it("pending state resolves after completion — sequential refresh still possible", async () => {
    const { mockFetch, deferred } = deferredFetch();
    global.fetch = mockFetch as unknown as typeof fetch;

    const store = createAuthStore({ baseUrl: "http://localhost:4000" });

    const first = store.ensureAccessToken(true);
    await flush();
    deferred[0].resolve("tok_first");
    await expect(first).resolves.toBe("tok_first");

    // The single-flight slot must be free again.
    const second = store.ensureAccessToken(true);
    await flush();
    expect(refreshCalls(mockFetch)).toHaveLength(2);
    deferred[1].resolve("tok_second");
    await expect(second).resolves.toBe("tok_second");
  });

  it("pending state resolves after refresh error — a later refresh can retry", async () => {
    const { mockFetch, deferred } = deferredFetch();
    global.fetch = mockFetch as unknown as typeof fetch;

    const store = createAuthStore({ baseUrl: "http://localhost:4000" });

    const first = store.ensureAccessToken(true);
    await flush();
    deferred[0].resolve(null); // HTTP 401
    await expect(first).resolves.toBeNull();
    expect(store.hasAccessToken()).toBe(false);

    const second = store.ensureAccessToken(true);
    await flush();
    expect(refreshCalls(mockFetch)).toHaveLength(2);
    deferred[1].resolve("tok_recovered");
    await expect(second).resolves.toBe("tok_recovered");
    expect(store.getAccessToken()).toBe("tok_recovered");
  });

  it("late refresh response cannot resurrect a session after logout", async () => {
    const { mockFetch, deferred } = deferredFetch();
    global.fetch = mockFetch as unknown as typeof fetch;

    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken("tok_initial", 900);
    await flush();

    const pending = store.ensureAccessToken(true);
    await flush();

    store.clearAccessToken(); // logout while refresh is in flight
    expect(store.getAccessToken()).toBeNull();

    deferred[0].resolve("tok_late"); // backend answered after logout
    // The caller is told the operation no longer holds authority (null),
    // never handed a token that belongs to a revoked session.
    await expect(pending).resolves.toBeNull();
    await flush();
    // …and the store must NOT adopt it.
    expect(store.getAccessToken()).toBeNull();
    expect(store.hasAccessToken()).toBe(false);
    expect(store.getSessionState().status).toBe("unauthorized");
  });

  it("late refresh response cannot overwrite a newer user's token", async () => {
    const { mockFetch, deferred } = deferredFetch();
    global.fetch = mockFetch as unknown as typeof fetch;

    const store = createAuthStore({ baseUrl: "http://localhost:4000" });

    const pending = store.ensureAccessToken(true);
    await flush();

    // A newer login (e.g. verify-otp adoption) lands while the old
    // refresh is still in flight.
    store.setAccessToken("tok_newer_user", 900);
    await flush();

    deferred[0].resolve("tok_stale");
    await flush();

    // The newer user's token survives; the stale refresh resolves superseded
    // (ensureAccessToken maps that to null) and clobbers nothing.
    expect(store.getAccessToken()).toBe("tok_newer_user");
    await expect(pending).resolves.toBeNull();
  });
});
