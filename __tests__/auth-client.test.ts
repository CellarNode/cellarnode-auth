import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthClient } from "../src/auth-client.js";
import { createAuthStore } from "../src/auth-store.js";
import { AuthError } from "../src/types.js";
import type {
  AuthStore,
  AuthUser,
  SessionResolution,
} from "../src/types.js";

const userA: AuthUser = {
  id: "user_1",
  email: "user@example.test",
  name: "User",
  userType: "importer",
  orgId: "org_a",
  roles: ["member"],
  createdAt: "2026-01-01T00:00:00.000Z",
};

function mockStore(
  token: string | null = "tok_old",
  resolution: SessionResolution = {
    status: "ready",
    token: "tok_new",
    user: userA,
  },
): AuthStore {
  let currentToken = token;
  return {
    getAccessToken: vi.fn(() => currentToken),
    hasAccessToken: vi.fn().mockReturnValue(token !== null),
    setAccessToken: vi.fn(),
    clearAccessToken: vi.fn(() => {
      currentToken = null;
    }),
    ensureAccessToken: vi.fn().mockResolvedValue(token),
    resolveSession: vi.fn(async () => {
      if (resolution.status === "ready") currentToken = resolution.token;
      if (resolution.status === "unauthorized") currentToken = null;
      return resolution;
    }),
    getUserId: vi.fn().mockReturnValue(token ? userA.id : null),
    getOrgId: vi.fn().mockReturnValue(token ? userA.orgId : null),
    getUserType: vi.fn().mockReturnValue(token ? userA.userType : null),
    getEntitlements: vi.fn().mockReturnValue([]),
    onOrgChange: vi.fn().mockReturnValue(() => {}),
    onAccessTokenSet: vi.fn().mockReturnValue(() => {}),
    onLogout: vi.fn().mockReturnValue(() => {}),
  };
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe("createAuthClient", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("injects Bearer token on authenticated requests", async () => {
    const store = mockStore("tok_abc");
    global.fetch = vi.fn().mockResolvedValue(response({ data: "ok" }));

    const client = createAuthClient({ baseUrl: "http://localhost:4000", store });
    await client.fetch("/some/path");

    const headers = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
      .headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer tok_abc");
  });

  it("skips Bearer token when skipAuth is true", async () => {
    const store = mockStore("tok_abc");
    global.fetch = vi.fn().mockResolvedValue(response({ data: "ok" }));

    const client = createAuthClient({ baseUrl: "http://localhost:4000", store });
    await client.fetch("/auth/register", { skipAuth: true });

    const headers = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
      .headers as Headers;
    expect(headers.get("Authorization")).toBeNull();
  });

  it("blocks first transport while token authority is unresolved", async () => {
    const store = mockStore("tok_pending");
    (store.getUserId as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const client = createAuthClient({ baseUrl: "http://localhost:4000", store });

    await expect(client.fetch("/api/write")).rejects.toMatchObject({
      status: 503,
      code: "SESSION_UNAVAILABLE",
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("retries once after validated same-user same-org refresh", async () => {
    const store = mockStore();
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(response({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401))
      .mockResolvedValueOnce(response({ data: "success" }));

    const client = createAuthClient({ baseUrl: "http://localhost:4000", store });
    await expect(client.fetch<{ data: string }>("/api/write")).resolves.toEqual({
      data: "success",
    });

    expect(store.resolveSession).toHaveBeenCalledWith({ refresh: true });
    const retryHeaders = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1][1]
      .headers as Headers;
    expect(retryHeaders.get("Authorization")).toBe("Bearer tok_new");
  });

  it("does not refresh replacement session after stale request returns 401", async () => {
    let resolveFirst!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const store = mockStore("tok_a");
    const onAuthFailure = vi.fn();
    global.fetch = vi.fn().mockReturnValue(first);
    const client = createAuthClient({
      baseUrl: "http://localhost:4000",
      store,
      onAuthFailure,
    });

    const staleRequest = client.fetch("/api/write");
    const userB = { ...userA, id: "user_2", orgId: "org_b" };
    (store.getAccessToken as ReturnType<typeof vi.fn>).mockReturnValue("tok_b");
    (store.getUserId as ReturnType<typeof vi.fn>).mockReturnValue(userB.id);
    (store.getOrgId as ReturnType<typeof vi.fn>).mockReturnValue(userB.orgId);
    store.getSessionState = vi.fn().mockReturnValue({
      status: "ready",
      token: "tok_b",
      user: userB,
    });
    resolveFirst(response({ code: "UNAUTHORIZED" }, 401));

    await expect(staleRequest).rejects.toMatchObject({
      status: 409,
      code: "SESSION_SUPERSEDED",
    });
    expect(store.resolveSession).not.toHaveBeenCalled();
    expect(onAuthFailure).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("reuses ready rotated token for same user and org without refreshing", async () => {
    let resolveFirst!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const store = mockStore("tok_a");
    global.fetch = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(response({ data: "success" }));
    const client = createAuthClient({ baseUrl: "http://localhost:4000", store });

    const staleRequest = client.fetch<{ data: string }>("/api/write");
    (store.getAccessToken as ReturnType<typeof vi.fn>).mockReturnValue("tok_b");
    store.getSessionState = vi.fn().mockReturnValue({
      status: "ready",
      token: "tok_b",
      user: userA,
    });
    resolveFirst(response({ code: "UNAUTHORIZED" }, 401));

    await expect(staleRequest).resolves.toEqual({ data: "success" });
    expect(store.resolveSession).not.toHaveBeenCalled();
    const retryHeaders = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1][1]
      .headers as Headers;
    expect(retryHeaders.get("Authorization")).toBe("Bearer tok_b");
  });

  it("does not replay an org-A request after refresh resolves org B", async () => {
    const store = mockStore("tok_old", {
      status: "ready",
      token: "tok_b",
      user: { ...userA, orgId: "org_b" },
    });
    global.fetch = vi
      .fn()
      .mockResolvedValue(response({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401));

    const client = createAuthClient({ baseUrl: "http://localhost:4000", store });
    await expect(client.fetch("/api/write")).rejects.toMatchObject({
      status: 409,
      code: "SESSION_SUPERSEDED",
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(store.clearAccessToken).not.toHaveBeenCalled();
  });

  it("does not replay when ready token was superseded before continuity check", async () => {
    const store = mockStore();
    let superseded = false;
    store.getSessionState = vi.fn(() =>
      superseded
        ? { status: "resolving", token: "tok_later" }
        : { status: "ready", token: "tok_old", user: userA },
    );
    (store.resolveSession as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      (store.getAccessToken as ReturnType<typeof vi.fn>).mockReturnValue("tok_later");
      superseded = true;
      return { status: "ready", token: "tok_new", user: userA };
    });
    global.fetch = vi
      .fn()
      .mockResolvedValue(response({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401));

    const client = createAuthClient({ baseUrl: "http://localhost:4000", store });
    await expect(client.fetch("/api/write")).rejects.toMatchObject({
      status: 409,
      code: "SESSION_SUPERSEDED",
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("returns unavailable when same-token authority starts resolving again", async () => {
    const store = mockStore();
    let authorityUnavailable = false;
    store.getSessionState = vi.fn(() =>
      authorityUnavailable
        ? { status: "unavailable", token: "tok_new" }
        : { status: "ready", token: "tok_old", user: userA },
    );
    (store.resolveSession as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      (store.getAccessToken as ReturnType<typeof vi.fn>).mockReturnValue("tok_new");
      (store.getUserId as ReturnType<typeof vi.fn>).mockReturnValue(null);
      (store.getOrgId as ReturnType<typeof vi.fn>).mockReturnValue(null);
      authorityUnavailable = true;
      return { status: "ready", token: "tok_new", user: userA };
    });
    global.fetch = vi
      .fn()
      .mockResolvedValue(response({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401));

    const client = createAuthClient({ baseUrl: "http://localhost:4000", store });
    await expect(client.fetch("/api/write")).rejects.toMatchObject({
      status: 503,
      code: "SESSION_UNAVAILABLE",
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves credentials and suppresses replay when refresh is unavailable", async () => {
    const store = mockStore("tok_old", {
      status: "unavailable",
      token: "tok_old",
    });
    global.fetch = vi
      .fn()
      .mockResolvedValue(response({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401));

    const client = createAuthClient({ baseUrl: "http://localhost:4000", store });
    await expect(client.fetch("/api/write")).rejects.toMatchObject({
      status: 503,
      code: "SESSION_UNAVAILABLE",
    });
    expect(store.clearAccessToken).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("returns actual retry failure and preserves validated session", async () => {
    const store = mockStore();
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(response({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401))
      .mockResolvedValueOnce(response({ error: "Unavailable", code: "UPSTREAM_DOWN" }, 503));

    const client = createAuthClient({ baseUrl: "http://localhost:4000", store });
    await expect(client.fetch("/api/write")).rejects.toMatchObject({
      status: 503,
      code: "UPSTREAM_DOWN",
    });
    expect(store.clearAccessToken).not.toHaveBeenCalled();
  });

  it("calls onAuthFailure only for confirmed refresh revocation", async () => {
    const store = mockStore("tok_old", { status: "unauthorized" });
    global.fetch = vi
      .fn()
      .mockResolvedValue(response({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401));
    const onAuthFailure = vi.fn();

    const client = createAuthClient({
      baseUrl: "http://localhost:4000",
      store,
      onAuthFailure,
    });
    await expect(client.fetch("/api/write")).rejects.toBeInstanceOf(AuthError);
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
    expect(store.clearAccessToken).not.toHaveBeenCalled();
  });

  it("preserves legacy no-resolver 401 logout behavior", async () => {
    const store = mockStore("tok_old");
    delete store.resolveSession;
    global.fetch = vi
      .fn()
      .mockResolvedValue(response({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401));
    const onAuthFailure = vi.fn();
    const client = createAuthClient({
      baseUrl: "http://localhost:4000",
      store,
      onAuthFailure,
    });

    await expect(client.fetch("/api/write")).rejects.toMatchObject({ status: 401 });
    expect(store.clearAccessToken).toHaveBeenCalledTimes(1);
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
  });

  it("does not clear replacement session in legacy no-resolver 401 path", async () => {
    let resolveFirst!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const store = mockStore("tok_a");
    delete store.resolveSession;
    const onAuthFailure = vi.fn();
    global.fetch = vi.fn().mockReturnValue(first);
    const client = createAuthClient({
      baseUrl: "http://localhost:4000",
      store,
      onAuthFailure,
    });

    const staleRequest = client.fetch("/api/write");
    (store.getAccessToken as ReturnType<typeof vi.fn>).mockReturnValue("tok_b");
    (store.getUserId as ReturnType<typeof vi.fn>).mockReturnValue("user_2");
    (store.getOrgId as ReturnType<typeof vi.fn>).mockReturnValue("org_b");
    resolveFirst(response({ code: "UNAUTHORIZED" }, 401));

    await expect(staleRequest).rejects.toMatchObject({
      status: 409,
      code: "SESSION_SUPERSEDED",
    });
    expect(store.clearAccessToken).not.toHaveBeenCalled();
    expect(onAuthFailure).not.toHaveBeenCalled();
  });

  it("suppresses stale unauthorized result after replacement installs", async () => {
    const store = mockStore("tok_a", { status: "unauthorized" });
    const userB = { ...userA, id: "user_2", orgId: "org_b" };
    let replaced = false;
    (store.getAccessToken as ReturnType<typeof vi.fn>).mockImplementation(() =>
      replaced ? "tok_b" : "tok_a",
    );
    (store.getUserId as ReturnType<typeof vi.fn>).mockImplementation(() =>
      replaced ? userB.id : userA.id,
    );
    (store.getOrgId as ReturnType<typeof vi.fn>).mockImplementation(() =>
      replaced ? userB.orgId : userA.orgId,
    );
    store.getSessionState = vi.fn(() =>
      replaced
        ? { status: "ready", token: "tok_b", user: userB }
        : { status: "ready", token: "tok_a", user: userA },
    );
    (store.resolveSession as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      queueMicrotask(() => {
        replaced = true;
      });
      return { status: "unauthorized" };
    });
    global.fetch = vi
      .fn()
      .mockResolvedValue(response({ code: "UNAUTHORIZED" }, 401));
    const onAuthFailure = vi.fn();
    const client = createAuthClient({
      baseUrl: "http://localhost:4000",
      store,
      onAuthFailure,
    });

    await expect(client.fetch("/api/write")).rejects.toMatchObject({
      status: 409,
      code: "SESSION_SUPERSEDED",
    });
    expect(onAuthFailure).not.toHaveBeenCalled();
    expect(store.clearAccessToken).not.toHaveBeenCalled();
  });

  it("captures principal before transport and rejects foreign-user refresh", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith("/api/write")) {
        return Promise.resolve(response({ code: "UNAUTHORIZED" }, 401));
      }
      if (url.endsWith("/auth/refresh")) {
        return Promise.resolve(response({ accessToken: "tok_other", expiresIn: 900 }));
      }
      const bearer = new Headers(init?.headers).get("Authorization");
      return Promise.resolve(
        response(bearer === "Bearer tok_other" ? { ...userA, id: "user_2" } : userA),
      );
    });
    global.fetch = fetchMock as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    store.setAccessToken("tok_a", 900);
    await store.resolveSession({ refresh: false });
    const client = createAuthClient({ baseUrl: "http://localhost:4000", store });

    await expect(client.fetch("/api/write")).rejects.toMatchObject({ status: 401 });
    expect(store.getAccessToken()).toBeNull();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/write"))).toHaveLength(1);
  });

  it("throws AuthError details on ordinary errors", async () => {
    const store = mockStore(null, { status: "unauthorized" });
    global.fetch = vi.fn().mockResolvedValue(
      response(
        {
          error: "Invalid OTP code",
          code: "OTP_INVALID",
          remainingAttempts: 2,
        },
        400,
      ),
    );

    const client = createAuthClient({ baseUrl: "http://localhost:4000", store });
    await expect(
      client.fetch("/auth/verify-otp", { skipAuth: true }),
    ).rejects.toMatchObject({
      status: 400,
      code: "OTP_INVALID",
      remainingAttempts: 2,
    });
  });
});
