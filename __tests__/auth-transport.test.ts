import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthApi } from "../src/auth-api.js";
import { createAuthClient } from "../src/auth-client.js";
import { createAuthStore } from "../src/auth-store.js";
import type { AuthStore, AuthUser } from "../src/types.js";

const user: AuthUser = {
  id: "user_1",
  email: "user@example.test",
  name: "User",
  userType: "producer",
  orgId: "org_1",
  roles: ["member"],
  createdAt: "2026-01-01T00:00:00.000Z",
};

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function readyStore(): AuthStore {
  return {
    getAccessToken: vi.fn().mockReturnValue("tok_old"),
    hasAccessToken: vi.fn().mockReturnValue(true),
    setAccessToken: vi.fn(),
    clearAccessToken: vi.fn(),
    ensureAccessToken: vi.fn().mockResolvedValue("tok_old"),
    getSessionState: vi.fn().mockReturnValue({
      status: "ready",
      token: "tok_old",
      user,
    }),
    getUserId: vi.fn().mockReturnValue(user.id),
    getOrgId: vi.fn().mockReturnValue(user.orgId),
    getUserType: vi.fn().mockReturnValue(user.userType),
    getEntitlements: vi.fn().mockReturnValue([]),
    onOrgChange: vi.fn().mockReturnValue(() => {}),
    onAccessTokenSet: vi.fn().mockReturnValue(() => {}),
    onLogout: vi.fn().mockReturnValue(() => {}),
  };
}

describe("auth transport policy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    "http://api.example.test",
    "http://localhost.example.test",
    "ftp://api.example.test",
    "https://user:secret@api.example.test",
    "not a URL",
  ])("rejects unsafe base URL %s before OTP transport", async (baseUrl) => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;
    const client = createAuthClient({ baseUrl, store: readyStore() });

    await expect(
      client.fetch("/auth/request-otp", {
        method: "POST",
        skipAuth: true,
        body: JSON.stringify({ email: "user@example.test" }),
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "http://localhost:4000",
    "http://127.0.0.1:4000",
    "http://[::1]:4000",
  ])("allows exact loopback HTTP host %s", async (baseUrl) => {
    const fetchMock = vi.fn().mockResolvedValue(response({ ok: true }));
    global.fetch = fetchMock;
    const client = createAuthClient({ baseUrl, store: readyStore() });

    await expect(
      client.fetch("/auth/request-otp", { skipAuth: true }),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("preserves base path and forces redirect rejection after caller init", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ ok: true }));
    global.fetch = fetchMock;
    const client = createAuthClient({
      baseUrl: "https://api.example.test/v2",
      store: readyStore(),
    });

    await client.fetch("/auth/request-otp", {
      method: "POST",
      skipAuth: true,
      redirect: "follow",
      body: JSON.stringify({ email: "user@example.test" }),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/v2/auth/request-otp",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it.each(["https://other.example.test/auth/me", "../auth/me"])(
    "rejects request URL outside configured base path: %s",
    async (path) => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock;
      const client = createAuthClient({
        baseUrl: "https://api.example.test/v2",
        store: readyStore(),
      });

      await expect(
        client.fetch(path, { skipAuth: true }),
      ).rejects.toBeInstanceOf(TypeError);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("applies transport rejection to explicit-token getMe without network", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;
    const store = readyStore();
    const client = createAuthClient({
      baseUrl: "http://api.example.test",
      store,
    });
    const api = createAuthApi({ client, store });

    await expect(api.getMe("tok_explicit")).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forces redirect rejection on initial request and authenticated retry", async () => {
    let token = "tok_old";
    const store = readyStore();
    (store.getAccessToken as ReturnType<typeof vi.fn>).mockImplementation(
      () => token,
    );
    (store.getSessionState as ReturnType<typeof vi.fn>).mockImplementation(
      () => ({ status: "ready", token, user }),
    );
    store.resolveSession = vi.fn(async () => {
      token = "tok_new";
      return { status: "ready", token, user };
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ code: "UNAUTHORIZED" }, 401))
      .mockResolvedValueOnce(response({ ok: true }));
    global.fetch = fetchMock;
    const client = createAuthClient({
      baseUrl: "https://api.example.test/v2",
      store,
    });

    await expect(
      client.fetch("/api/write", { redirect: "follow" }),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ redirect: "error" }),
    );
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("applies base-path and redirect policy to refresh and identity", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/refresh")) {
        return Promise.resolve(response({ accessToken: "tok_new", expiresIn: 900 }));
      }
      return Promise.resolve(response(user));
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const store = createAuthStore({ baseUrl: "https://api.example.test/v2" });

    await expect(store.resolveSession({ refresh: true })).resolves.toMatchObject({
      status: "ready",
      token: "tok_new",
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.example.test/v2/auth/refresh",
      "https://api.example.test/v2/auth/me",
    ]);
    expect(fetchMock.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
    store.clearAccessToken();
  });

  it("keeps devLogin nonrejecting while blocking unsafe transport", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;
    const store = createAuthStore({ baseUrl: "http://api.example.test" });

    await expect(store.devLogin?.("dev@example.test")).resolves.toMatchObject({
      ok: false,
      reason: "network",
      status: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
