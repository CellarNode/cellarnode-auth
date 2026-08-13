import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAuthStore } from "../src/auth-store.js";
import type { AuthUser } from "../src/types.js";

/**
 * CEL-1364 — `devLogin()` is the local-dev bypass of the OTP round-trip. It
 * POSTs the backend's `/test/login` and must adopt the returned JWE through the
 * SAME store path verify-otp uses: identity fetch, refresh scheduling, and the
 * `onAccessTokenSet` / `onOrgChange` fan-out all behave identically.
 *
 * The other half of the contract is anti-enumeration (backend T3-1): the 404
 * body is identical for "gate off" and "no such user", so the client maps it to
 * ONE reason and frames it as "the gate is off" — never as a statement about
 * the account.
 */

const baseMe: AuthUser = {
  id: "user_dev",
  email: "dev@example.com",
  name: "Dev",
  userType: "producer",
  orgId: "org_dev",
  roles: ["member"],
  entitlements: ["elabel"],
  createdAt: "2024-01-01T00:00:00.000Z",
};

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: () => Promise.resolve(body) };
}

/**
 * Route a mock fetch by URL: `/test/login` returns `devLogin`, `/auth/me`
 * returns identity. Recorded calls are asserted on directly.
 */
function routedFetch(opts: {
  devLogin: { body: unknown; ok?: boolean; status?: number } | "throws";
  me?: AuthUser | null;
}) {
  return vi.fn((url: string, init?: RequestInit) => {
    if (typeof url === "string" && url.includes("/test/login")) {
      if (opts.devLogin === "throws") {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      void init;
      return Promise.resolve(
        jsonResponse(
          opts.devLogin.body,
          opts.devLogin.ok ?? true,
          opts.devLogin.status ?? 200,
        ),
      );
    }
    if (typeof url === "string" && url.includes("/auth/me")) {
      if (opts.me == null) {
        return Promise.resolve(jsonResponse({ error: "unauthorized" }, false, 401));
      }
      return Promise.resolve(jsonResponse(opts.me));
    }
    return Promise.resolve(jsonResponse({}, false, 404));
  });
}

/** Flush pending microtasks so async identity resolution settles. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const OK_BODY = { accessToken: "jwe.dev.token", userId: "user_dev", orgId: "org_dev" };

describe("createAuthStore — devLogin adoption (CEL-1364)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("POSTs the email to /test/login with credentials so the refresh cookie is stored", async () => {
    // Given: a store pointed at a local backend.
    const fetchMock = routedFetch({ devLogin: { body: OK_BODY }, me: baseMe });
    global.fetch = fetchMock as unknown as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });

    // When: a developer triggers the bypass.
    await store.devLogin?.("dev@example.com");

    // Then: the request carries the address and includes cookies — the backend
    // sets the same refresh cookies the OTP flow sets, and `/auth/refresh`
    // afterwards depends on them being stored.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:4000/test/login");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(JSON.parse(init.body as string)).toEqual({ email: "dev@example.com" });
  });

  it("adopts the token through the same path verify-otp uses", async () => {
    // Given: a backend that mints a session and an identity behind it.
    global.fetch = routedFetch({ devLogin: { body: OK_BODY }, me: baseMe }) as unknown as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    const tokenSet = vi.fn();
    const orgChanged = vi.fn();
    store.onAccessTokenSet(tokenSet);
    store.onOrgChange(orgChanged);

    // When: the bypass succeeds.
    const result = await store.devLogin?.("dev@example.com");
    await flush();

    // Then: the token is live and identity resolved from /auth/me, exactly as
    // after a real verify-otp — not a parallel adoption path.
    expect(result).toMatchObject({ ok: true, accessToken: "jwe.dev.token" });
    expect(store.getAccessToken()).toBe("jwe.dev.token");
    expect(store.getUserId()).toBe("user_dev");
    expect(store.getOrgId()).toBe("org_dev");
    expect(store.getUserType()).toBe("producer");
    expect(store.getEntitlements()).toEqual(["elabel"]);

    // And: both listener families fired, in the documented order.
    expect(tokenSet).toHaveBeenCalledWith("jwe.dev.token");
    expect(orgChanged).toHaveBeenCalledWith("org_dev");
  });

  it("schedules the refresh timer from expiresIn, defaulting to 900s", async () => {
    // Given: fake timers so the scheduled refresh is observable, and a backend
    // whose /test/login body omits expiresIn (the real route's email branch
    // returns accessToken/userId/orgId only).
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    global.fetch = routedFetch({ devLogin: { body: OK_BODY }, me: baseMe }) as unknown as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });

    // When: the bypass succeeds.
    const result = await store.devLogin?.("dev@example.com");

    // Then: the token carries the shared 900s fallback and a refresh is armed
    // for (900 - 60)s — the same scheduling verify-otp gets.
    expect(result).toMatchObject({ ok: true, expiresIn: 900 });
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 840_000);
  });

  it("honours a server-supplied expiresIn", async () => {
    // Given: a backend that returns an explicit lifetime.
    global.fetch = routedFetch({
      devLogin: { body: { ...OK_BODY, expiresIn: 60 } },
      me: baseMe,
    }) as unknown as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });

    // When / Then: the store reports the server's value, not the fallback.
    await expect(store.devLogin?.("dev@example.com")).resolves.toMatchObject({
      ok: true,
      expiresIn: 60,
    });
  });
});

describe("createAuthStore — devLogin failure mapping (CEL-1364)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("maps the uniform 404 to the gate-off hint without claiming anything about the account", async () => {
    // Given: the backend's T3-1 response — the SAME body for "gate off" and
    // "no such user".
    global.fetch = routedFetch({
      devLogin: { body: { error: "Test endpoints disabled", code: "TEST_ENDPOINTS_DISABLED" }, ok: false, status: 404 },
    }) as unknown as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });

    // When: the bypass is attempted.
    const result = await store.devLogin?.("ghost@example.com");

    // Then: one actionable reason naming the env gate.
    expect(result).toMatchObject({ ok: false, reason: "test-endpoints-disabled", status: 404 });

    // And: the copy never asserts the account's existence either way — doing so
    // would turn a deliberately uniform response into an enumeration oracle.
    const message = (result as { message: string }).message;
    expect(message).toContain("ENABLE_TEST_ENDPOINTS=true");
    expect(message).not.toMatch(/no account|not found|does not exist|unknown (user|email)/i);
    expect(message).not.toContain("ghost@example.com");

    // And: no session was adopted.
    expect(store.getAccessToken()).toBeNull();
  });

  it("distinguishes rate limiting, fixture-secret rejection, and other statuses", async () => {
    for (const [status, reason] of [
      [429, "rate-limited"],
      [403, "forbidden"],
      [500, "unexpected"],
    ] as const) {
      // Given: a backend returning each non-404 failure.
      global.fetch = routedFetch({
        devLogin: { body: { error: "nope", code: "X" }, ok: false, status },
      }) as unknown as typeof fetch;
      const store = createAuthStore({ baseUrl: "http://localhost:4000" });

      // When / Then: each maps to its own reason, so the UI can say something
      // useful instead of blaming the env gate for everything.
      await expect(store.devLogin?.("dev@example.com")).resolves.toMatchObject({
        ok: false,
        reason,
        status,
      });
    }
  });

  it("reports a network failure instead of rejecting", async () => {
    // Given: no backend listening.
    global.fetch = routedFetch({ devLogin: "throws" }) as unknown as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });

    // When / Then: the caller gets a result, never a thrown error — the DEV
    // button has no other error channel.
    await expect(store.devLogin?.("dev@example.com")).resolves.toMatchObject({
      ok: false,
      reason: "network",
      status: null,
    });
  });

  it("does not adopt a session when the response carries no token", async () => {
    // Given: a 200 with an unexpected shape.
    global.fetch = routedFetch({ devLogin: { body: { ok: true } }, me: baseMe }) as unknown as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });

    // When: the bypass "succeeds" at the HTTP layer.
    const result = await store.devLogin?.("dev@example.com");
    await flush();

    // Then: the store stays logged out rather than half-adopting.
    expect(result).toMatchObject({ ok: false, reason: "malformed-response" });
    expect(store.getAccessToken()).toBeNull();
    expect(store.hasAccessToken()).toBe(false);
  });

  it("reports malformed-response for a literal null body instead of rejecting", async () => {
    // Given: a 200 whose body is valid JSON `null`. It PARSES, so the
    // json()-throws branch never runs, and `extractAccessToken` would
    // dereference null and throw straight out of `devLogin` — breaking the
    // never-throws contract that `DevLoginResult` promises its only caller (a
    // click handler with no other error channel).
    global.fetch = routedFetch({
      devLogin: { body: null },
      me: baseMe,
    }) as unknown as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });

    // When / Then: a resolved failure, never a rejection.
    await expect(store.devLogin?.("dev@example.com")).resolves.toMatchObject({
      ok: false,
      reason: "malformed-response",
      status: 200,
    });
    await flush();
    expect(store.getAccessToken()).toBeNull();
    expect(store.hasAccessToken()).toBe(false);
  });
});
