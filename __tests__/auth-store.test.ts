import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SignJWT } from "jose";
import { createAuthStore } from "../src/auth-store.js";

/**
 * Helper — sign an unverified HS256 JWT carrying SessionClaims. The
 * client-side decoder does NOT verify the signature, so any secret will do.
 */
async function signClaims(claims: Record<string, unknown>): Promise<string> {
  const secret = new TextEncoder().encode("test-secret-key-for-unit-tests-only");
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(secret);
}

const baseClaims = {
  userId: "user_123",
  email: "alice@example.com",
  sessionId: "sess_abc",
  roles: ["member"],
  userType: "importer" as const,
};

describe("createAuthStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts with no token", () => {
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    expect(store.getAccessToken()).toBeNull();
    expect(store.hasAccessToken()).toBe(false);
  });

  it("stores and retrieves a token", () => {
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken("tok_123", 900);
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

  it("decodes entitlements from the JWT (CEL-599)", async () => {
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    const token = await signClaims({ ...baseClaims, entitlements: ["producer-dashboard", "elabel"] });
    store.setAccessToken(token, 900);
    expect(store.getEntitlements()).toEqual(["producer-dashboard", "elabel"]);
    expect(store.getSessionClaims()?.entitlements).toEqual(["producer-dashboard", "elabel"]);
  });

  it("defaults entitlements to [] for tokens that predate the claim", async () => {
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    const token = await signClaims(baseClaims); // no entitlements field
    store.setAccessToken(token, 900);
    expect(store.getEntitlements()).toEqual([]);
    expect(store.getSessionClaims()?.entitlements).toEqual([]);
  });

  it("getEntitlements returns [] when logged out", () => {
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    expect(store.getEntitlements()).toEqual([]);
  });

  it("getEntitlements returns a defensive copy", async () => {
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    const token = await signClaims({ ...baseClaims, entitlements: ["producer-dashboard"] });
    store.setAccessToken(token, 900);
    const ents = store.getEntitlements();
    ents.push("hacked");
    expect(store.getEntitlements()).toEqual(["producer-dashboard"]);
  });

  it("filters non-string entitlement elements from a malformed claim", async () => {
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    const token = await signClaims({ ...baseClaims, entitlements: ["producer-dashboard", 42, null, "elabel"] });
    store.setAccessToken(token, 900);
    expect(store.getEntitlements()).toEqual(["producer-dashboard", "elabel"]);
  });

  it("schedules refresh before expiry", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ accessToken: "tok_refreshed", expiresIn: 900 }),
    });
    global.fetch = mockFetch;

    const store = createAuthStore({
      baseUrl: "http://localhost:4000",
      refreshBuffer: 60,
    });
    store.setAccessToken("tok_123", 120); // expires in 120s, refresh at 60s

    // Advance to just before refresh buffer
    vi.advanceTimersByTime(59_000);
    expect(mockFetch).not.toHaveBeenCalled();

    // Advance past refresh buffer (60s mark)
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:4000/auth/refresh",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });

  it("deduplicates concurrent refreshes", async () => {
    let resolveRefresh!: (v: Response) => void;
    const mockFetch = vi.fn().mockReturnValue(
      new Promise<Response>((r) => { resolveRefresh = r; }),
    );
    global.fetch = mockFetch;

    const store = createAuthStore({ baseUrl: "http://localhost:4000" });

    const p1 = store.ensureAccessToken(true);
    const p2 = store.ensureAccessToken(true);

    resolveRefresh(new Response(JSON.stringify({ accessToken: "tok_new", expiresIn: 900 }), { status: 200 }));

    const [t1, t2] = await Promise.all([p1, p2]);
    expect(t1).toBe("tok_new");
    expect(t2).toBe("tok_new");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns existing token without refresh when not forced", async () => {
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken("tok_existing", 900);

    const token = await store.ensureAccessToken();
    expect(token).toBe("tok_existing");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns null when refresh fails", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: "Invalid token" }),
    });

    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    const token = await store.ensureAccessToken(true);
    expect(token).toBeNull();
  });

  it("cancels refresh timer on clearAccessToken", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ accessToken: "tok_refreshed", expiresIn: 900 }),
    });
    global.fetch = mockFetch;

    const store = createAuthStore({
      baseUrl: "http://localhost:4000",
      refreshBuffer: 60,
    });
    store.setAccessToken("tok_123", 120);
    store.clearAccessToken();

    // Advance past when refresh would have fired
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("createAuthStore — session claim getters (v0.9.0)", () => {
  // Real timers — JWT helper uses Date internally and we don't need fake
  // timers for the claim accessors.
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("returns null for all getters when no token is set", () => {
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    expect(store.getSessionClaims()).toBeNull();
    expect(store.getUserId()).toBeNull();
    expect(store.getOrgId()).toBeNull();
    expect(store.getUserType()).toBeNull();
  });

  it("decodes claims from a valid JWT", async () => {
    const token = await signClaims({ ...baseClaims, orgId: "org_1" });
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken(token, 900);

    const claims = store.getSessionClaims();
    expect(claims).not.toBeNull();
    expect(claims?.userId).toBe("user_123");
    expect(claims?.email).toBe("alice@example.com");
    expect(claims?.orgId).toBe("org_1");
    expect(claims?.sessionId).toBe("sess_abc");
    expect(claims?.roles).toEqual(["member"]);
    expect(claims?.userType).toBe("importer");

    expect(store.getUserId()).toBe("user_123");
    expect(store.getOrgId()).toBe("org_1");
    expect(store.getUserType()).toBe("importer");
  });

  it("returns null orgId for admin tokens (orgId=null in JWT)", async () => {
    const token = await signClaims({ ...baseClaims, orgId: null, userType: "admin" });
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken(token, 900);

    expect(store.getOrgId()).toBeNull();
    expect(store.getUserType()).toBe("admin");
    expect(store.getSessionClaims()?.orgId).toBeNull();
  });

  it("malformed JWT → claims set to null, no extra listeners fire (orgId stays null)", () => {
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    const orgListener = vi.fn();
    store.onOrgChange(orgListener);

    // Garbage string is not a valid JWT — decoder returns null.
    store.setAccessToken("not-a-jwt", 900);

    expect(store.getSessionClaims()).toBeNull();
    expect(store.getUserId()).toBeNull();
    expect(store.getOrgId()).toBeNull();
    // orgId transitioned null → null; onOrgChange must NOT fire (safer
    // contract: malformed tokens do not synthesise spurious events).
    expect(orgListener).not.toHaveBeenCalled();
  });

  it("malformed JWT after a valid one fires onOrgChange(null)", async () => {
    const token = await signClaims({ ...baseClaims, orgId: "org_1" });
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken(token, 900);

    const orgListener = vi.fn();
    store.onOrgChange(orgListener);

    store.setAccessToken("not-a-jwt", 900);

    // orgId went org_1 → null because claims could not be decoded.
    expect(orgListener).toHaveBeenCalledTimes(1);
    expect(orgListener).toHaveBeenCalledWith(null);
  });

  it("getSessionClaims returns a defensive copy — caller mutations cannot leak into internal state", async () => {
    const token = await signClaims({ ...baseClaims, orgId: "org_1" });
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken(token, 900);

    const first = store.getSessionClaims();
    expect(first).not.toBeNull();
    // Mutate the returned object + nested roles array.
    first!.userId = "tampered";
    first!.roles.push("admin-injected");

    // A subsequent read must reflect the original, untampered claims.
    const second = store.getSessionClaims();
    expect(second?.userId).toBe("user_123");
    expect(second?.roles).toEqual(["member"]);

    // Each call returns a distinct object (no shared reference).
    expect(second).not.toBe(first);
    expect(second?.roles).not.toBe(first!.roles);
  });
});

describe("createAuthStore — event surface (v0.9.0)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("onOrgChange fires once when token with new orgId is set from null", async () => {
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    const listener = vi.fn();
    store.onOrgChange(listener);

    const token = await signClaims({ ...baseClaims, orgId: "org_1" });
    store.setAccessToken(token, 900);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("org_1");
  });

  it("onOrgChange does NOT fire when same orgId is re-set (refresh)", async () => {
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    const token1 = await signClaims({ ...baseClaims, orgId: "org_1" });
    store.setAccessToken(token1, 900);

    const listener = vi.fn();
    store.onOrgChange(listener);

    // Simulate a refresh — new JWT, same orgId.
    const token2 = await signClaims({ ...baseClaims, orgId: "org_1", sessionId: "sess_def" });
    store.setAccessToken(token2, 900);

    expect(listener).not.toHaveBeenCalled();
  });

  it("onOrgChange fires with null when an admin token (orgId=null) is set", async () => {
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    const token1 = await signClaims({ ...baseClaims, orgId: "org_1" });
    store.setAccessToken(token1, 900);

    const listener = vi.fn();
    store.onOrgChange(listener);

    const adminToken = await signClaims({ ...baseClaims, orgId: null, userType: "admin" });
    store.setAccessToken(adminToken, 900);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(null);
  });

  it("onAccessTokenSet fires every setAccessToken call (even with same orgId)", async () => {
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    const listener = vi.fn();
    store.onAccessTokenSet(listener);

    const token1 = await signClaims({ ...baseClaims, orgId: "org_1" });
    const token2 = await signClaims({ ...baseClaims, orgId: "org_1", sessionId: "sess_def" });
    store.setAccessToken(token1, 900);
    store.setAccessToken(token2, 900);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(1, token1);
    expect(listener).toHaveBeenNthCalledWith(2, token2);
  });

  it("onLogout fires on clearAccessToken", async () => {
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    const listener = vi.fn();
    store.onLogout(listener);

    const token = await signClaims({ ...baseClaims, orgId: "org_1" });
    store.setAccessToken(token, 900);

    expect(listener).not.toHaveBeenCalled();
    store.clearAccessToken();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("multiple listeners receive the event (fan-out)", async () => {
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    store.onOrgChange(a);
    store.onOrgChange(b);
    store.onOrgChange(c);

    const token = await signClaims({ ...baseClaims, orgId: "org_1" });
    store.setAccessToken(token, 900);

    expect(a).toHaveBeenCalledWith("org_1");
    expect(b).toHaveBeenCalledWith("org_1");
    expect(c).toHaveBeenCalledWith("org_1");
  });

  it("unsubscribe stops receiving events", async () => {
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

    const token = await signClaims({ ...baseClaims, orgId: "org_1" });
    store.setAccessToken(token, 900);
    store.clearAccessToken();

    expect(orgListener).not.toHaveBeenCalled();
    expect(tokenListener).not.toHaveBeenCalled();
    expect(logoutListener).not.toHaveBeenCalled();
  });

  it("a throwing listener does not break event fan-out", async () => {
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    store.onOrgChange(bad);
    store.onOrgChange(good);

    const token = await signClaims({ ...baseClaims, orgId: "org_1" });
    expect(() => store.setAccessToken(token, 900)).not.toThrow();

    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledWith("org_1");
  });
});
