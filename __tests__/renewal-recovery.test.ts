import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthStore } from "../src/auth-store.js";
import type { AuthUser, SessionState } from "../src/types.js";

/**
 * CEL-2107 — recovery after a renewal fails on the network (QA of CEL-2086).
 *
 * 1. A `/auth/me` 401 on a confirmed session whose token was not just rotated
 *    (an access token that expired while its renewal could not run) asks the
 *    refresh cookie before signing out. Only a refused rotation is
 *    `unauthorized`; a rotation that fails on the network stays `unavailable`.
 * 2. A failed scheduled renewal is retried on a bounded backoff.
 * 3. `revalidateSession()` ("Try again") renews while a renewal is owed,
 *    because a remint keeps the old expiry.
 */

const userA: AuthUser = {
  id: "user_1",
  email: "user@example.test",
  name: "User",
  userType: "producer",
  orgId: "org_a",
  roles: ["member"],
  entitlements: ["producer-dashboard"],
  createdAt: "2026-01-01T00:00:00.000Z",
};

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

type Route = (init?: RequestInit) => Promise<Response>;

/** Routes fetch by path; records every call's path in order. */
function routeFetch(routes: {
  me: Route;
  refresh?: Route;
  revalidate?: Route;
}): string[] {
  const calls: string[] = [];
  global.fetch = vi.fn((url: string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (path === "/auth/me") return routes.me(init);
    if (path === "/auth/refresh" && routes.refresh) return routes.refresh(init);
    if (path === "/auth/revalidate" && routes.revalidate) return routes.revalidate(init);
    return Promise.reject(new TypeError(`unrouted ${path}`));
  }) as typeof fetch;
  return calls;
}

const bearer = (init?: RequestInit) =>
  new Headers(init?.headers).get("Authorization")?.slice(7) ?? "";

async function readySession(store: ReturnType<typeof createAuthStore>) {
  store.setAccessToken("tok_a", 900);
  const ready = await store.resolveSession({ refresh: false });
  expect(ready.status).toBe("ready");
}

describe("renewal recovery (CEL-2107)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("an expired token whose rotation fails on the network stays unavailable, never signs out", async () => {
    let expired = false;
    const calls = routeFetch({
      me: () =>
        Promise.resolve(expired ? response({ code: "UNAUTHORIZED" }, 401) : response(userA)),
      refresh: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    await readySession(store);
    const states: SessionState["status"][] = [];
    store.onSessionStateChange((state) => states.push(state.status));

    expired = true;
    const result = await store.resolveSession({ refresh: false });

    expect(result).toEqual({ status: "unavailable", token: "tok_a" });
    expect(store.getAccessToken()).toBe("tok_a");
    expect(states).not.toContain("unauthorized");
    expect(calls.filter((c) => c === "/auth/refresh")).toHaveLength(1);
  });

  it("an expired token recovers through the refresh cookie when rotation succeeds", async () => {
    let expired = false;
    routeFetch({
      me: (init) =>
        Promise.resolve(
          expired && bearer(init) === "tok_a"
            ? response({ code: "UNAUTHORIZED" }, 401)
            : response(userA),
        ),
      refresh: () => Promise.resolve(response({ accessToken: "tok_b", expiresIn: 900 })),
    });
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    await readySession(store);

    expired = true;
    const result = await store.resolveSession({ refresh: false });

    expect(result).toMatchObject({ status: "ready", token: "tok_b" });
    expect(store.getAccessToken()).toBe("tok_b");
  });

  it("an expired token whose rotation is refused signs out", async () => {
    let expired = false;
    routeFetch({
      me: () =>
        Promise.resolve(expired ? response({ code: "UNAUTHORIZED" }, 401) : response(userA)),
      refresh: () => Promise.resolve(response({ code: "UNAUTHORIZED" }, 401)),
    });
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    await readySession(store);

    expired = true;
    const result = await store.resolveSession({ refresh: false });

    expect(result).toEqual({ status: "unauthorized" });
    expect(store.getAccessToken()).toBeNull();
  });

  it("retries a failed scheduled renewal on a backoff until it succeeds", async () => {
    vi.useFakeTimers();
    let refreshOnline = false;
    const calls = routeFetch({
      me: () => Promise.resolve(response(userA)),
      refresh: () =>
        refreshOnline
          ? Promise.resolve(response({ accessToken: "tok_b", expiresIn: 900 }))
          : Promise.reject(new TypeError("Failed to fetch")),
    });
    const store = createAuthStore({ baseUrl: "http://localhost:4000", refreshBuffer: 60 });
    await readySession(store);

    // The scheduled renewal fires (900s - 60s buffer) and fails on the network.
    await vi.advanceTimersByTimeAsync(840_000);
    expect(calls.filter((c) => c === "/auth/refresh")).toHaveLength(1);
    expect(store.getSessionState().status).toBe("unavailable");

    // First backoff step (5s) retries while still offline…
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.filter((c) => c === "/auth/refresh")).toHaveLength(2);

    // …the next step (15s) runs once the network is back and recovers.
    refreshOnline = true;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls.filter((c) => c === "/auth/refresh")).toHaveLength(3);
    expect(store.getSessionState()).toMatchObject({ status: "ready", token: "tok_b" });
  });

  it("revalidateSession renews (not remints) while a renewal is owed", async () => {
    vi.useFakeTimers();
    let refreshOnline = false;
    const calls = routeFetch({
      me: () => Promise.resolve(response(userA)),
      refresh: () =>
        refreshOnline
          ? Promise.resolve(response({ accessToken: "tok_b", expiresIn: 900 }))
          : Promise.reject(new TypeError("Failed to fetch")),
      revalidate: () => Promise.resolve(response({ accessToken: "tok_remint" })),
    });
    const store = createAuthStore({ baseUrl: "http://localhost:4000", refreshBuffer: 60 });
    await readySession(store);
    await vi.advanceTimersByTimeAsync(840_000);
    expect(store.getSessionState().status).toBe("unavailable");

    refreshOnline = true;
    const result = await store.revalidateSession();

    expect(result).toMatchObject({ status: "ready", token: "tok_b" });
    expect(calls).not.toContain("/auth/revalidate");
  });

  it("revalidateSession still remints when no renewal is owed", async () => {
    const calls = routeFetch({
      me: () => Promise.resolve(response(userA)),
      revalidate: () => Promise.resolve(response({ accessToken: "tok_remint" })),
    });
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    await readySession(store);

    const result = await store.revalidateSession();

    expect(result).toMatchObject({ status: "ready", token: "tok_remint" });
    expect(calls).toContain("/auth/revalidate");
    expect(calls).not.toContain("/auth/refresh");
  });
});
