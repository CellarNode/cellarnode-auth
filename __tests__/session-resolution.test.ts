import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthClient } from "../src/auth-client.js";
import { createAuthStore } from "../src/auth-store.js";
import type { AuthUser } from "../src/types.js";

const userA: AuthUser = {
  id: "user_1",
  email: "user@example.test",
  name: "User",
  userType: "importer",
  orgId: "org_a",
  roles: ["member"],
  entitlements: ["importer-dashboard"],
  createdAt: "2026-01-01T00:00:00.000Z",
};

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("atomic session resolution (CEL-1782)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ["missing orgId", (({ orgId: _orgId, ...rest }) => rest)(userA)],
    ["missing userType", (({ userType: _userType, ...rest }) => rest)(userA)],
    ["malformed roles", { ...userA, roles: ["member", 4] }],
    ["malformed entitlements", { ...userA, entitlements: ["ok", null] }],
    ["missing createdAt", (({ createdAt: _createdAt, ...rest }) => rest)(userA)],
  ])("treats %s as unavailable without clearing credentials", async (_name, body) => {
    global.fetch = vi.fn().mockResolvedValue(response(body));
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });

    store.setAccessToken("tok_a", 900);
    const result = await store.resolveSession({ refresh: false });

    expect(result).toEqual({ status: "unavailable", token: "tok_a" });
    expect(store.getAccessToken()).toBe("tok_a");
    expect(store.getUserId()).toBeNull();
    expect(store.getOrgId()).toBeNull();
  });

  it("accepts explicit membership-null as authenticated profile", async () => {
    const membershipNull: AuthUser = {
      ...userA,
      userType: null,
      orgId: null,
      roles: [],
    };
    global.fetch = vi.fn().mockResolvedValue(response(membershipNull));
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });

    store.setAccessToken("tok_none", 900);
    const result = await store.resolveSession({ refresh: false });

    expect(result).toMatchObject({ status: "ready", user: membershipNull });
    expect(store.getUserId()).toBe(userA.id);
    expect(store.getOrgId()).toBeNull();
    expect(store.getUserType()).toBeNull();
  });

  it("publishes resolving before credential mutation and ready before legacy events", async () => {
    const identities = new Map([
      ["tok_a", userA],
      ["tok_b", { ...userA, orgId: "org_b" }],
    ]);
    global.fetch = vi.fn((_url, init) => {
      const token = new Headers(init?.headers).get("Authorization")?.slice(7) ?? "";
      return Promise.resolve(response(identities.get(token)));
    }) as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken("tok_a", 900);
    await flush();

    const order: string[] = [];
    store.onSessionStateChange((state) => {
      if (state.status === "resolving") {
        order.push(`resolving:${store.getAccessToken()}:${store.getOrgId()}`);
      } else if (state.status === "ready") {
        order.push(`state-ready:${store.getAccessToken()}:${store.getOrgId()}`);
      }
    });
    store.onAccessTokenSet(() => order.push("token"));
    store.onOrgChange(() => order.push("org"));
    order.length = 0;

    store.setAccessToken("tok_b", 900);
    expect(order).toEqual(["resolving:tok_a:org_a"]);
    await flush();
    expect(order).toEqual([
      "resolving:tok_a:org_a",
      "state-ready:tok_b:org_b",
      "token",
      "org",
    ]);
  });

  it("blocks transport started synchronously by a resolving observer", async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        response(url.endsWith("/auth/me") ? userA : { data: "sent" }),
      ),
    );
    global.fetch = fetchMock as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken("tok_a", 900);
    await flush();
    const client = createAuthClient({ baseUrl: "http://localhost:4000", store });
    let attemptedWrite: Promise<unknown> | null = null;
    store.onSessionStateChange((state) => {
      if (state.status === "resolving") {
        attemptedWrite = client.fetch("/api/write");
      }
    });

    store.setAccessToken("tok_b", 900);

    expect(store.getUserId()).toBeNull();
    expect(attemptedWrite).not.toBeNull();
    await expect(attemptedWrite).rejects.toMatchObject({
      status: 503,
      code: "SESSION_UNAVAILABLE",
    });
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/write")),
    ).toHaveLength(0);
  });

  it("joins explicit adoption when a resolving observer requests refresh", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const token = new Headers(init?.headers).get("Authorization");
      return Promise.resolve(
        response(token === "Bearer tok_a" ? { ...userA, orgId: "org_a" } : userA),
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken("tok_b", 900);
    await store.resolveSession({ refresh: false });

    let observerResolution: Promise<unknown> | null = null;
    store.onSessionStateChange((state) => {
      if (state.status === "resolving" && state.token === "tok_a") {
        observerResolution = store.resolveSession({ refresh: true });
      }
    });

    store.setAccessToken("tok_a", 900);

    await expect(observerResolution).resolves.toMatchObject({
      status: "ready",
      token: "tok_a",
    });
    expect(store.getAccessToken()).toBe("tok_a");
    expect(store.getSessionState()).toMatchObject({
      status: "ready",
      token: "tok_a",
    });
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith("/auth/refresh"),
      ),
    ).toHaveLength(0);
  });

  it("lets nested explicit login supersede an adoption without stale events", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const token = new Headers(init?.headers).get("Authorization")?.slice(7);
      return Promise.resolve(
        response({ ...userA, orgId: token === "tok_c" ? "org_c" : "org_b" }),
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken("tok_b", 900);
    await store.resolveSession({ refresh: false });
    const tokenEvents: Array<string | null> = [];
    store.onAccessTokenSet((token) => tokenEvents.push(token));
    store.onSessionStateChange((state) => {
      if (state.status === "resolving" && state.token === "tok_a") {
        store.setAccessToken("tok_c", 900);
      }
    });

    store.setAccessToken("tok_a", 900);
    await expect(store.resolveSession({ refresh: false })).resolves.toMatchObject({
      status: "ready",
      token: "tok_c",
    });

    expect(store.getAccessToken()).toBe("tok_c");
    expect(store.getOrgId()).toBe("org_c");
    expect(tokenEvents).toEqual(["tok_c"]);
    expect(
      fetchMock.mock.calls.some(([, init]) =>
        new Headers(init?.headers).get("Authorization") === "Bearer tok_a",
      ),
    ).toBe(false);
  });

  it("lets nested logout supersede explicit adoption", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(userA));
    global.fetch = fetchMock;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken("tok_b", 900);
    await store.resolveSession({ refresh: false });
    store.onSessionStateChange((state) => {
      if (state.status === "resolving" && state.token === "tok_a") {
        store.clearAccessToken();
      }
    });

    store.setAccessToken("tok_a", 900);

    await expect(store.resolveSession({ refresh: false })).resolves.toEqual({
      status: "unauthorized",
    });
    expect(store.getAccessToken()).toBeNull();
    expect(store.getSessionState()).toEqual({ status: "unauthorized" });
    expect(
      fetchMock.mock.calls.some(([, init]) =>
        new Headers(init?.headers).get("Authorization") === "Bearer tok_a",
      ),
    ).toBe(false);
  });

  it("deduplicates timer and manual refresh into one refresh and identity flight", async () => {
    vi.useFakeTimers();
    const refresh = deferred<Response>();
    let identityCalls = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/auth/refresh")) return refresh.promise;
      identityCalls += 1;
      return Promise.resolve(response(userA));
    });
    global.fetch = fetchMock as typeof fetch;
    const store = createAuthStore({
      baseUrl: "http://localhost:4000",
      refreshBuffer: 60,
    });
    store.setAccessToken("tok_a", 120);
    await flush();

    await vi.advanceTimersByTimeAsync(60_000);
    const manual = store.resolveSession({ refresh: true });
    refresh.resolve(response({ accessToken: "tok_new", expiresIn: 900 }));
    await expect(manual).resolves.toMatchObject({ status: "ready", token: "tok_new" });

    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/auth/refresh"))).toHaveLength(1);
    expect(identityCalls).toBe(2);
  });

  it("publishes the adopted token while refreshed identity is resolving", async () => {
    const refreshedIdentity = deferred<Response>();
    global.fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/auth/refresh")) {
        return Promise.resolve(response({ accessToken: "tok_b", expiresIn: 900 }));
      }
      const token = new Headers(init?.headers).get("Authorization");
      return token === "Bearer tok_b"
        ? refreshedIdentity.promise
        : Promise.resolve(response(userA));
    }) as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken("tok_a", 900);
    await store.resolveSession({ refresh: false });

    const resolvingTokens: Array<string | null> = [];
    store.onSessionStateChange((state) => {
      if (state.status === "resolving") resolvingTokens.push(state.token);
    });

    const refreshing = store.resolveSession({ refresh: true });
    await flush();

    expect(resolvingTokens).toEqual(["tok_a", "tok_b"]);
    expect(store.getAccessToken()).toBe("tok_b");
    expect(store.getSessionState()).toEqual({
      status: "resolving",
      token: "tok_b",
    });

    refreshedIdentity.resolve(response(userA));
    await expect(refreshing).resolves.toMatchObject({
      status: "ready",
      token: "tok_b",
    });
  });

  it("installs refresh flight before publishing resolving to reentrant observers", async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        url.includes("/auth/refresh")
          ? response({ accessToken: "tok_b", expiresIn: 900 })
          : response(userA),
      ),
    );
    global.fetch = fetchMock as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken("tok_a", 900);
    await store.resolveSession({ refresh: false });

    let nested: Promise<unknown> | null = null;
    const unsubscribe = store.onSessionStateChange((state) => {
      if (state.status === "resolving" && state.token === "tok_a" && !nested) {
        nested = store.resolveSession({ refresh: true });
      }
    });
    const outer = store.resolveSession({ refresh: true });

    await expect(outer).resolves.toMatchObject({ status: "ready", token: "tok_b" });
    await expect(nested).resolves.toMatchObject({ status: "ready", token: "tok_b" });
    unsubscribe();
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/auth/refresh")),
    ).toHaveLength(1);
  });

  it("joins non-refresh callers to refresh and suppresses prior identity commit", async () => {
    const staleIdentity = deferred<Response>();
    const refresh = deferred<Response>();
    let identityCalls = 0;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/auth/refresh")) return refresh.promise;
      identityCalls += 1;
      if (identityCalls === 2) return staleIdentity.promise;
      const token = new Headers(init?.headers).get("Authorization");
      return Promise.resolve(
        response(token === "Bearer tok_b" ? { ...userA, roles: [] } : userA),
      );
    });
    global.fetch = fetchMock as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken("tok_a", 900);
    await store.resolveSession({ refresh: false });

    const stale = store.resolveSession({ refresh: false });
    const refreshing = store.resolveSession({ refresh: true });
    const joined = store.resolveSession({ refresh: false });
    staleIdentity.resolve(response({ ...userA, roles: ["stale"] }));
    await expect(stale).resolves.toEqual({ status: "superseded" });
    expect(store.getUserId()).toBeNull();

    refresh.resolve(response({ accessToken: "tok_b", expiresIn: 900 }));
    await expect(refreshing).resolves.toMatchObject({
      status: "ready",
      token: "tok_b",
      user: { roles: [] },
    });
    await expect(joined).resolves.toMatchObject({ status: "ready", token: "tok_b" });
    expect(identityCalls).toBe(3);
  });

  it("logout during refresh cannot resurrect credentials", async () => {
    const refresh = deferred<Response>();
    global.fetch = vi.fn((url: string) =>
      url.includes("/auth/refresh")
        ? refresh.promise
        : Promise.resolve(response(userA)),
    ) as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken("tok_a", 900);
    await flush();

    const resolving = store.resolveSession({ refresh: true });
    store.clearAccessToken();
    refresh.resolve(response({ accessToken: "tok_stale", expiresIn: 900 }));

    await expect(resolving).resolves.toEqual({ status: "superseded" });
    expect(store.getAccessToken()).toBeNull();
  });

  it("old refresh response cannot clear a newer explicit login", async () => {
    const refresh = deferred<Response>();
    global.fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/auth/refresh")) return refresh.promise;
      const token = new Headers(init?.headers).get("Authorization");
      return Promise.resolve(
        response(token === "Bearer tok_b" ? { ...userA, orgId: "org_b" } : userA),
      );
    }) as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken("tok_a", 900);
    await flush();

    const old = store.resolveSession({ refresh: true });
    store.setAccessToken("tok_b", 900);
    await flush();
    refresh.resolve(response({ error: "Unauthorized" }, 401));

    await expect(old).resolves.toEqual({ status: "superseded" });
    expect(store.getAccessToken()).toBe("tok_b");
    expect(store.getOrgId()).toBe("org_b");
  });

  it("refreshes once before adopting same-token raw org change", async () => {
    let currentRead = 0;
    const tokenEvents: Array<string | null> = [];
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/auth/refresh")) {
        return Promise.resolve(response({ accessToken: "tok_b", expiresIn: 900 }));
      }
      const token = new Headers(init?.headers).get("Authorization");
      if (token === "Bearer tok_b") {
        return Promise.resolve(response({ ...userA, orgId: "org_b" }));
      }
      currentRead += 1;
      return Promise.resolve(
        response(currentRead === 1 ? userA : { ...userA, orgId: "org_b" }),
      );
    });
    global.fetch = fetchMock as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.onAccessTokenSet((token) => tokenEvents.push(token));
    store.setAccessToken("tok_a", 900);
    await store.resolveSession({ refresh: false });

    const result = await store.resolveSession({ refresh: false });
    expect(result).toMatchObject({ status: "ready", token: "tok_b" });
    expect(store.getOrgId()).toBe("org_b");
    expect(tokenEvents).toEqual(["tok_a", "tok_b"]);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/auth/refresh"))).toHaveLength(1);
  });

  it("retains validated continuity across 503 before raw org mismatch", async () => {
    let identityRead = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/auth/refresh")) {
        return Promise.resolve(response({ code: "AUTHORITY_UNAVAILABLE" }, 503));
      }
      identityRead += 1;
      if (identityRead === 1) return Promise.resolve(response(userA));
      if (identityRead === 2) {
        return Promise.resolve(response({ code: "AUTHORITY_UNAVAILABLE" }, 503));
      }
      return Promise.resolve(response({ ...userA, orgId: "org_b" }));
    });
    global.fetch = fetchMock as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken("tok_a", 900);
    await store.resolveSession({ refresh: false });

    await expect(store.resolveSession({ refresh: false })).resolves.toEqual({
      status: "unavailable",
      token: "tok_a",
    });
    await expect(store.resolveSession({ refresh: false })).resolves.toEqual({
      status: "unavailable",
      token: "tok_a",
    });

    expect(store.getOrgId()).toBeNull();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/auth/refresh"))).toHaveLength(1);
  });

  it("fails closed when refresh resolves a different account", async () => {
    global.fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/auth/refresh")) {
        return Promise.resolve(response({ accessToken: "tok_other", expiresIn: 900 }));
      }
      const token = new Headers(init?.headers).get("Authorization");
      return Promise.resolve(
        response(token === "Bearer tok_other" ? { ...userA, id: "user_2" } : userA),
      );
    }) as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken("tok_a", 900);
    await flush();

    await expect(store.resolveSession({ refresh: true })).resolves.toEqual({
      status: "unauthorized",
    });
    expect(store.getAccessToken()).toBeNull();
  });

  it("503 and role-removal outcomes preserve correct authority semantics", async () => {
    let mode: "ready" | "unavailable" | "removed" = "ready";
    global.fetch = vi.fn(() => {
      if (mode === "unavailable") {
        return Promise.resolve(response({ code: "AUTHORITY_UNAVAILABLE" }, 503));
      }
      return Promise.resolve(
        response(mode === "removed" ? { ...userA, roles: [] } : userA),
      );
    }) as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    const orgChange = vi.fn();
    store.onOrgChange(orgChange);
    store.setAccessToken("tok_a", 900);
    await store.resolveSession({ refresh: false });
    orgChange.mockClear();

    mode = "unavailable";
    await expect(store.resolveSession({ refresh: false })).resolves.toEqual({
      status: "unavailable",
      token: "tok_a",
    });
    expect(store.getAccessToken()).toBe("tok_a");
    expect(store.getUserId()).toBeNull();
    expect(orgChange).not.toHaveBeenCalled();

    mode = "removed";
    const recovered = await store.resolveSession({ refresh: false });
    expect(recovered).toMatchObject({ status: "ready", user: { roles: [] } });
    expect(store.getUserId()).toBe(userA.id);
    expect(orgChange).not.toHaveBeenCalled();
  });

  it("caller abort returns superseded without aborting shared adoption", async () => {
    const identity = deferred<Response>();
    let calls = 0;
    global.fetch = vi.fn(() => {
      calls += 1;
      return calls === 1
        ? Promise.resolve(response(userA))
        : identity.promise;
    }) as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken("tok_a", 900);
    await flush();

    const controller = new AbortController();
    const caller = store.resolveSession({ refresh: false, signal: controller.signal });
    controller.abort();
    await expect(caller).resolves.toEqual({ status: "superseded" });

    identity.resolve(response({ ...userA, roles: [] }));
    await flush();
    expect(store.getUserId()).toBe(userA.id);
  });

  it("generation-checks resolving observers before refresh mutation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(userA));
    global.fetch = fetchMock;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken("tok_a", 900);
    await flush();

    const unsubscribe = store.onSessionStateChange((state) => {
      if (state.status === "resolving" && state.token === "tok_a") {
        unsubscribe();
        store.clearAccessToken();
      }
    });
    const result = await store.resolveSession({ refresh: true });

    expect(result).toEqual({ status: "superseded" });
    expect(store.getAccessToken()).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/auth/refresh"))).toBe(false);
  });

  it("returns superseded when unauthorized observer installs replacement", async () => {
    const unauthorized = deferred<Response>();
    let identityCalls = 0;
    global.fetch = vi.fn((_url: string, init?: RequestInit) => {
      identityCalls += 1;
      if (identityCalls === 2) return unauthorized.promise;
      const token = new Headers(init?.headers).get("Authorization");
      return Promise.resolve(
        response(token === "Bearer tok_b" ? { ...userA, orgId: "org_b" } : userA),
      );
    }) as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken("tok_a", 900);
    await store.resolveSession({ refresh: false });
    const tokenEvents: Array<string | null> = [];
    const logout = vi.fn();
    store.onAccessTokenSet((token) => tokenEvents.push(token));
    store.onLogout(logout);
    store.onSessionStateChange((state) => {
      if (state.status === "unauthorized") store.setAccessToken("tok_b", 900);
    });
    const staleUnauthorized = vi.fn();
    store.onSessionStateChange((state) => {
      if (state.status === "unauthorized") staleUnauthorized();
    });

    const stale = store.resolveSession({ refresh: false });
    unauthorized.resolve(response({ code: "UNAUTHORIZED" }, 401));

    await expect(stale).resolves.toEqual({ status: "superseded" });
    await store.resolveSession({ refresh: false });
    expect(store.getAccessToken()).toBe("tok_b");
    expect(store.getOrgId()).toBe("org_b");
    expect(tokenEvents).not.toContain(null);
    expect(logout).not.toHaveBeenCalled();
    expect(staleUnauthorized).not.toHaveBeenCalled();
  });

  it("suppresses stale logout when clear observer installs replacement", async () => {
    global.fetch = vi.fn((_url: string, init?: RequestInit) => {
      const token = new Headers(init?.headers).get("Authorization");
      return Promise.resolve(
        response(token === "Bearer tok_b" ? { ...userA, orgId: "org_b" } : userA),
      );
    }) as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken("tok_a", 900);
    await store.resolveSession({ refresh: false });
    const tokenEvents: Array<string | null> = [];
    const logout = vi.fn();
    store.onAccessTokenSet((token) => tokenEvents.push(token));
    store.onLogout(logout);
    store.onSessionStateChange((state) => {
      if (state.status === "unauthorized") store.setAccessToken("tok_b", 900);
    });

    store.clearAccessToken();
    await store.resolveSession({ refresh: false });

    expect(store.getAccessToken()).toBe("tok_b");
    expect(tokenEvents).not.toContain(null);
    expect(logout).not.toHaveBeenCalled();
  });

  it("suppresses remaining logout listeners after replacement login", async () => {
    global.fetch = vi.fn((_url: string, init?: RequestInit) => {
      const token = new Headers(init?.headers).get("Authorization");
      return Promise.resolve(
        response(token === "Bearer tok_b" ? { ...userA, orgId: "org_b" } : userA),
      );
    }) as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken("tok_a", 900);
    await store.resolveSession({ refresh: false });
    const staleLogout = vi.fn();
    store.onLogout(() => store.setAccessToken("tok_b", 900));
    store.onLogout(staleLogout);

    store.clearAccessToken();
    await store.resolveSession({ refresh: false });

    expect(store.getAccessToken()).toBe("tok_b");
    expect(store.getOrgId()).toBe("org_b");
    expect(staleLogout).not.toHaveBeenCalled();
  });

  it("does not publish legacy token-set event for unavailable authority", async () => {
    let unavailable = false;
    global.fetch = vi.fn(() =>
      Promise.resolve(
        unavailable
          ? response({ code: "AUTHORITY_UNAVAILABLE" }, 503)
          : response(userA),
      ),
    ) as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    const tokenSet = vi.fn();
    store.onAccessTokenSet(tokenSet);
    store.setAccessToken("tok_a", 900);
    await store.resolveSession({ refresh: false });
    tokenSet.mockClear();

    unavailable = true;
    await expect(store.resolveSession({ refresh: false })).resolves.toEqual({
      status: "unavailable",
      token: "tok_a",
    });
    expect(tokenSet).not.toHaveBeenCalled();
  });

  it("times out hung identity flight and permits retry", async () => {
    vi.useFakeTimers();
    let calls = 0;
    global.fetch = vi.fn(() => {
      calls += 1;
      return calls === 1
        ? Promise.resolve({
            ok: true,
            status: 200,
            json: () => new Promise<unknown>(() => {}),
          } as Response)
        : Promise.resolve(response(userA));
    }) as typeof fetch;
    const store = createAuthStore({
      baseUrl: "http://localhost:4000",
      resolutionTimeoutMs: 50,
    });
    store.setAccessToken("tok_a", 900);
    const timedOut = store.resolveSession({ refresh: false });

    await vi.advanceTimersByTimeAsync(50);
    await expect(timedOut).resolves.toEqual({
      status: "unavailable",
      token: "tok_a",
    });
    await expect(store.resolveSession({ refresh: false })).resolves.toMatchObject({
      status: "ready",
    });
    expect(calls).toBe(2);
  });

  it("times out hung refresh flight and permits retry", async () => {
    vi.useFakeTimers();
    let refreshCalls = 0;
    global.fetch = vi.fn((url: string) => {
      if (!url.includes("/auth/refresh")) return Promise.resolve(response(userA));
      refreshCalls += 1;
      return refreshCalls === 1
        ? Promise.resolve({
            ok: true,
            status: 200,
            json: () => new Promise<unknown>(() => {}),
          } as Response)
        : Promise.resolve(response({ accessToken: "tok_b", expiresIn: 900 }));
    }) as typeof fetch;
    const store = createAuthStore({
      baseUrl: "http://localhost:4000",
      resolutionTimeoutMs: 50,
    });
    store.setAccessToken("tok_a", 900);
    await store.resolveSession({ refresh: false });
    const timedOut = store.resolveSession({ refresh: true });

    await vi.advanceTimersByTimeAsync(50);
    await expect(timedOut).resolves.toEqual({
      status: "unavailable",
      token: "tok_a",
    });
    await expect(store.resolveSession({ refresh: true })).resolves.toMatchObject({
      status: "ready",
      token: "tok_b",
    });
    expect(refreshCalls).toBe(2);
  });
});
