import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAuthStore } from "../src/auth-store.js";
import type { AuthUser } from "../src/types.js";

/**
 * CEL-622 — the public access token is an opaque, ENCRYPTED JWE (jose
 * EncryptJWT, alg dir / A256GCM). It is NOT client-decodable. Identity is
 * therefore sourced from `GET /auth/me`, which the auth-store fetches with the
 * bearer token whenever a token is acquired or changed.
 *
 * These tests drive `global.fetch`, routing by URL:
 *   - `/auth/me`      → identity (AuthUser) responses
 *   - `/auth/refresh` → refresh responses (token rotation)
 *
 * Because identity resolution is async, identity getters + `onAccessTokenSet`
 * + `onOrgChange` only settle AFTER the in-flight `/auth/me` resolves. Tests
 * await a microtask flush (`flush()`) after `setAccessToken` before asserting.
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

/** Build a mock Response-like object for a JSON body. */
function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  };
}

/**
 * Route a mock fetch by URL. `me` is the AuthUser (or null to fail /auth/me).
 * `refresh` is the refresh JSON body (or null to fail /auth/refresh).
 */
function routedFetch(opts: {
  me?: AuthUser | null;
  refresh?: { accessToken: string; expiresIn?: number } | null;
}) {
  return vi.fn((url: string) => {
    if (typeof url === "string" && url.includes("/auth/me")) {
      if (opts.me == null) return Promise.resolve(jsonResponse({ error: "unauthorized" }, false, 401));
      return Promise.resolve(jsonResponse(opts.me));
    }
    if (typeof url === "string" && url.includes("/auth/refresh")) {
      if (opts.refresh == null) return Promise.resolve(jsonResponse({ error: "invalid" }, false, 401));
      return Promise.resolve(jsonResponse(opts.refresh));
    }
    return Promise.resolve(jsonResponse({}, false, 404));
  });
}

/** Flush pending microtasks so async identity resolution settles. */
async function flush(): Promise<void> {
  // Multiple awaits drain chained promise resolutions (fetch → json → cache).
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("createAuthStore — token storage", () => {
  beforeEach(() => {
    global.fetch = routedFetch({ me: baseMe }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts with no token", () => {
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    expect(store.getAccessToken()).toBeNull();
    expect(store.hasAccessToken()).toBe(false);
  });

  it("stores and retrieves a token synchronously", () => {
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken("tok_123", 900);
    // Token is set synchronously even though identity resolves async.
    expect(store.getAccessToken()).toBe("tok_123");
    expect(store.hasAccessToken()).toBe(true);
  });

  it("clears the token", () => {
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken("tok_123", 900);
    store.clearAccessToken();
    expect(store.getAccessToken()).toBeNull();
    expect(store.hasAccessToken()).toBe(false);
  });
});

describe("createAuthStore — refresh timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("schedules refresh before expiry", async () => {
    const mockFetch = routedFetch({ me: baseMe, refresh: { accessToken: "tok_refreshed", expiresIn: 900 } });
    global.fetch = mockFetch as unknown as typeof fetch;

    const store = createAuthStore({
      baseUrl: "http://localhost:4000",
      refreshBuffer: 60,
    });
    store.setAccessToken("tok_123", 120); // expires in 120s, refresh at 60s

    // Advance to just before refresh buffer — no /auth/refresh yet.
    await vi.advanceTimersByTimeAsync(59_000);
    expect(
      mockFetch.mock.calls.some((c) => String(c[0]).includes("/auth/refresh")),
    ).toBe(false);

    // Advance past refresh buffer (60s mark).
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:4000/auth/refresh",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });

  it("deduplicates concurrent refreshes", async () => {
    let resolveRefresh!: (v: unknown) => void;
    const refreshPromise = new Promise((r) => {
      resolveRefresh = r;
    });
    const mockFetch = vi.fn((url: string) => {
      if (String(url).includes("/auth/me")) {
        return Promise.resolve(jsonResponse(baseMe));
      }
      return refreshPromise;
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const store = createAuthStore({ baseUrl: "http://localhost:4000" });

    const p1 = store.ensureAccessToken(true);
    const p2 = store.ensureAccessToken(true);

    resolveRefresh(jsonResponse({ accessToken: "tok_new", expiresIn: 900 }));

    const [t1, t2] = await Promise.all([p1, p2]);
    expect(t1).toBe("tok_new");
    expect(t2).toBe("tok_new");
    // Exactly one /auth/refresh call (dedup), regardless of /auth/me calls.
    const refreshCalls = mockFetch.mock.calls.filter((c) => !String(c[0]).includes("/auth/me"));
    expect(refreshCalls).toHaveLength(1);
  });

  it("returns existing token without refresh when not forced", async () => {
    const mockFetch = routedFetch({ me: baseMe });
    global.fetch = mockFetch as unknown as typeof fetch;

    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken("tok_existing", 900);

    const token = await store.ensureAccessToken();
    expect(token).toBe("tok_existing");
    // No /auth/refresh call (only /auth/me from setAccessToken's identity fetch).
    expect(
      mockFetch.mock.calls.some((c) => String(c[0]).includes("/auth/refresh")),
    ).toBe(false);
  });

  it("returns null when refresh fails", async () => {
    global.fetch = routedFetch({ me: baseMe, refresh: null }) as unknown as typeof fetch;

    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    const token = await store.ensureAccessToken(true);
    expect(token).toBeNull();
  });

  it("cancels refresh timer on clearAccessToken", async () => {
    const mockFetch = routedFetch({ me: baseMe, refresh: { accessToken: "tok_refreshed", expiresIn: 900 } });
    global.fetch = mockFetch as unknown as typeof fetch;

    const store = createAuthStore({
      baseUrl: "http://localhost:4000",
      refreshBuffer: 60,
    });
    store.setAccessToken("tok_123", 120);
    store.clearAccessToken();

    // Advance past when refresh would have fired.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(
      mockFetch.mock.calls.some((c) => String(c[0]).includes("/auth/refresh")),
    ).toBe(false);
  });
});

describe("createAuthStore — identity from /auth/me (CEL-622)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null/[] for all getters when no token is set", () => {
    global.fetch = routedFetch({ me: baseMe }) as unknown as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    expect(store.getUserId()).toBeNull();
    expect(store.getOrgId()).toBeNull();
    expect(store.getUserType()).toBeNull();
    expect(store.getEntitlements()).toEqual([]);
  });

  it("sources real identity from /auth/me after setAccessToken (the regression fix)", async () => {
    const mockFetch = routedFetch({ me: baseMe });
    global.fetch = mockFetch as unknown as typeof fetch;

    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken("opaque.jwe.token", 900);
    await flush();

    expect(store.getUserId()).toBe("user_123");
    expect(store.getOrgId()).toBe("org_1");
    expect(store.getUserType()).toBe("importer");
    expect(store.getEntitlements()).toEqual(["producer-dashboard", "elabel"]);

    // /auth/me was fetched with the bearer token + credentials.
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:4000/auth/me",
      expect.objectContaining({
        method: "GET",
        credentials: "include",
        headers: expect.objectContaining({ Authorization: "Bearer opaque.jwe.token" }),
      }),
    );
  });

  it("returns null orgId for admin identities (orgId=null from /auth/me)", async () => {
    global.fetch = routedFetch({ me: { ...baseMe, orgId: null, userType: "admin" } }) as unknown as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken("admin.jwe", 900);
    await flush();

    expect(store.getOrgId()).toBeNull();
    expect(store.getUserType()).toBe("admin");
  });

  it("defaults entitlements to [] when /auth/me omits them", async () => {
    const { entitlements, ...meWithout } = baseMe;
    void entitlements;
    global.fetch = routedFetch({ me: meWithout as AuthUser }) as unknown as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken("tok", 900);
    await flush();
    expect(store.getEntitlements()).toEqual([]);
  });

  it("getEntitlements returns a defensive copy", async () => {
    global.fetch = routedFetch({ me: baseMe }) as unknown as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken("tok", 900);
    await flush();

    const ents = store.getEntitlements();
    ents.push("hacked");
    expect(store.getEntitlements()).toEqual(["producer-dashboard", "elabel"]);
  });

  it("clears identity on clearAccessToken", async () => {
    global.fetch = routedFetch({ me: baseMe }) as unknown as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken("tok", 900);
    await flush();
    expect(store.getOrgId()).toBe("org_1");

    store.clearAccessToken();
    expect(store.getUserId()).toBeNull();
    expect(store.getOrgId()).toBeNull();
    expect(store.getUserType()).toBeNull();
    expect(store.getEntitlements()).toEqual([]);
  });

  it("identity becomes null (tolerated) when /auth/me fails — does not throw", async () => {
    global.fetch = routedFetch({ me: null }) as unknown as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    expect(() => store.setAccessToken("tok", 900)).not.toThrow();
    await flush();
    expect(store.getOrgId()).toBeNull();
    expect(store.getUserId()).toBeNull();
    expect(store.getEntitlements()).toEqual([]);
    // Token itself is still retained (the failure is tolerated, like performRefresh).
    expect(store.getAccessToken()).toBe("tok");
  });

  it("clears prior identity synchronously on a token switch (no stale leak before /auth/me resolves)", async () => {
    let me: AuthUser = baseMe;
    const mockFetch = vi.fn((url: string) => {
      if (String(url).includes("/auth/me")) return Promise.resolve(jsonResponse(me));
      return Promise.resolve(jsonResponse({}, false, 404));
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken("tok_user1", 900);
    await flush();
    expect(store.getUserId()).toBe("user_123");
    expect(store.getOrgId()).toBe("org_1");

    // Switch to a DIFFERENT session's token. Identity must clear SYNCHRONOUSLY —
    // before the new /auth/me resolves — so the previous user's id/org/entitlements
    // never leak across the session boundary.
    me = { ...baseMe, id: "user_999", orgId: "org_2", entitlements: [] };
    store.setAccessToken("tok_user2", 900);
    expect(store.getUserId()).toBeNull();
    expect(store.getOrgId()).toBeNull();
    expect(store.getEntitlements()).toEqual([]);

    // After resolution the new identity is in place.
    await flush();
    expect(store.getUserId()).toBe("user_999");
    expect(store.getOrgId()).toBe("org_2");
  });

  it("getSessionClaims is removed from the store surface", () => {
    global.fetch = routedFetch({ me: baseMe }) as unknown as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    expect((store as Record<string, unknown>).getSessionClaims).toBeUndefined();
  });
});

describe("createAuthStore — event surface (identity-sourced, CEL-622)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("onOrgChange fires once with the real orgId after identity resolves", async () => {
    global.fetch = routedFetch({ me: baseMe }) as unknown as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    const listener = vi.fn();
    store.onOrgChange(listener);

    store.setAccessToken("tok", 900);
    // Not yet — identity hasn't resolved.
    expect(listener).not.toHaveBeenCalled();

    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("org_1");
  });

  it("onAccessTokenSet fires with the token AFTER identity is cached", async () => {
    global.fetch = routedFetch({ me: baseMe }) as unknown as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });

    let orgIdAtEmit: string | null | undefined;
    store.onAccessTokenSet(() => {
      // Critical: getOrgId() must already be populated when this fires.
      orgIdAtEmit = store.getOrgId();
    });

    store.setAccessToken("tok", 900);
    expect(orgIdAtEmit).toBeUndefined(); // hasn't fired yet
    await flush();
    expect(orgIdAtEmit).toBe("org_1");
  });

  it("onOrgChange does NOT fire when same orgId is re-set (refresh)", async () => {
    global.fetch = routedFetch({ me: baseMe }) as unknown as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });

    store.setAccessToken("tok1", 900);
    await flush();

    const listener = vi.fn();
    store.onOrgChange(listener);

    store.setAccessToken("tok2", 900); // same orgId from /auth/me
    await flush();

    expect(listener).not.toHaveBeenCalled();
  });

  it("onOrgChange fires with null when an admin identity (orgId=null) is set after an org user", async () => {
    let me: AuthUser = baseMe;
    const mockFetch = vi.fn((url: string) => {
      if (String(url).includes("/auth/me")) return Promise.resolve(jsonResponse(me));
      return Promise.resolve(jsonResponse({}, false, 404));
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken("tok_org", 900);
    await flush();

    const listener = vi.fn();
    store.onOrgChange(listener);

    me = { ...baseMe, orgId: null, userType: "admin" };
    store.setAccessToken("tok_admin", 900);
    await flush();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(null);
  });

  it("onOrgChange fires once with null when the FIRST identity is an admin (orgId=null)", async () => {
    // Regression: previousOrgId=null must not double as "not emitted yet", or
    // the first admin identity (orgId null) would skip onOrgChange(null).
    global.fetch = routedFetch({ me: { ...baseMe, orgId: null, userType: "admin" } }) as unknown as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    const listener = vi.fn();
    store.onOrgChange(listener);

    store.setAccessToken("admin.jwe", 900);
    await flush();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(null);
  });

  it("logout resets org tracking so a subsequent login re-fires onOrgChange", async () => {
    global.fetch = routedFetch({ me: baseMe }) as unknown as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    const listener = vi.fn();
    store.onOrgChange(listener);

    store.setAccessToken("tok1", 900);
    await flush();
    expect(listener).toHaveBeenCalledTimes(1); // org_1

    store.clearAccessToken();

    // Same org again after re-login — must re-fire because logout reset prev-orgId.
    store.setAccessToken("tok2", 900);
    await flush();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(2, "org_1");
  });

  it("end-to-end: a useProducerOrgId-style consumer ends up with the real orgId", async () => {
    // Mirrors the dashboard hook: subscribe to onAccessTokenSet + onLogout,
    // re-read getOrgId() on each event.
    global.fetch = routedFetch({ me: baseMe }) as unknown as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });

    let observedOrgId: string | null = store.getOrgId();
    store.onAccessTokenSet(() => {
      observedOrgId = store.getOrgId();
    });
    store.onLogout(() => {
      observedOrgId = store.getOrgId();
    });

    // Login.
    store.setAccessToken("opaque.jwe", 900);
    await flush();
    expect(observedOrgId).toBe("org_1");

    // Logout.
    store.clearAccessToken();
    expect(observedOrgId).toBeNull();
  });

  it("onAccessTokenSet fires for each setAccessToken call", async () => {
    global.fetch = routedFetch({ me: baseMe }) as unknown as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    const listener = vi.fn();
    store.onAccessTokenSet(listener);

    store.setAccessToken("tok1", 900);
    await flush();
    store.setAccessToken("tok2", 900);
    await flush();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(1, "tok1");
    expect(listener).toHaveBeenNthCalledWith(2, "tok2");
  });

  it("onLogout fires on clearAccessToken (and onAccessTokenSet fires with null)", async () => {
    global.fetch = routedFetch({ me: baseMe }) as unknown as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    const logout = vi.fn();
    const tokenSet = vi.fn();
    store.onLogout(logout);
    store.onAccessTokenSet(tokenSet);

    store.setAccessToken("tok", 900);
    await flush();
    tokenSet.mockClear();

    store.clearAccessToken();
    expect(logout).toHaveBeenCalledTimes(1);
    // onAccessTokenSet(null) fires synchronously on clear (no /auth/me needed).
    expect(tokenSet).toHaveBeenCalledWith(null);
  });

  it("multiple listeners receive the event (fan-out)", async () => {
    global.fetch = routedFetch({ me: baseMe }) as unknown as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    store.onOrgChange(a);
    store.onOrgChange(b);
    store.onOrgChange(c);

    store.setAccessToken("tok", 900);
    await flush();

    expect(a).toHaveBeenCalledWith("org_1");
    expect(b).toHaveBeenCalledWith("org_1");
    expect(c).toHaveBeenCalledWith("org_1");
  });

  it("unsubscribe stops receiving events", async () => {
    global.fetch = routedFetch({ me: baseMe }) as unknown as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    const orgListener = vi.fn();
    const tokenListener = vi.fn();
    const logoutListener = vi.fn();

    const offOrg = store.onOrgChange(orgListener);
    const offToken = store.onAccessTokenSet(tokenListener);
    const offLogout = store.onLogout(logoutListener);

    offOrg();
    offToken();
    offLogout();

    store.setAccessToken("tok", 900);
    await flush();
    store.clearAccessToken();

    expect(orgListener).not.toHaveBeenCalled();
    expect(tokenListener).not.toHaveBeenCalled();
    expect(logoutListener).not.toHaveBeenCalled();
  });

  it("a throwing listener does not break event fan-out", async () => {
    global.fetch = routedFetch({ me: baseMe }) as unknown as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    store.onOrgChange(bad);
    store.onOrgChange(good);

    store.setAccessToken("tok", 900);
    await flush();

    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledWith("org_1");
  });
});
