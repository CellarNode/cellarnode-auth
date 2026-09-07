import { describe, it, expect, vi } from "vitest";
import { createAuthApi } from "../src/auth-api.js";
import { createAuthStore } from "../src/auth-store.js";
import { AuthError } from "../src/types.js";
import type { AuthClient, AuthStore } from "../src/types.js";

function mockClient(): AuthClient {
  return {
    fetch: vi.fn().mockResolvedValue({}),
  };
}

function mockStore(): AuthStore {
  return {
    getAccessToken: vi.fn().mockReturnValue(null),
    hasAccessToken: vi.fn().mockReturnValue(false),
    setAccessToken: vi.fn(),
    clearAccessToken: vi.fn(),
    ensureAccessToken: vi.fn().mockResolvedValue(null),
  };
}

describe("createAuthApi", () => {
  it("register calls POST /auth/register with skipAuth", async () => {
    const client = mockClient();
    (client.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      userId: "u1",
    });

    const api = createAuthApi({ client, store: mockStore() });
    const result = await api.register({
      name: "Test",
      email: "t@t.com",
      userType: "producer",
    });

    expect(result.userId).toBe("u1");
    expect(client.fetch).toHaveBeenCalledWith(
      "/auth/register",
      expect.objectContaining({
        method: "POST",
        skipAuth: true,
        body: expect.stringContaining('"userType":"producer"'),
      }),
    );
  });

  it("requestOtp calls POST /auth/request-otp with skipAuth", async () => {
    const client = mockClient();
    (client.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      expiresAt: "2026-03-14T12:00:00Z",
    });

    const api = createAuthApi({ client, store: mockStore() });
    const result = await api.requestOtp("t@t.com");

    expect(result.expiresAt).toBe("2026-03-14T12:00:00Z");
    expect(client.fetch).toHaveBeenCalledWith(
      "/auth/request-otp",
      expect.objectContaining({ method: "POST", skipAuth: true }),
    );
  });

  it("verifyOtp extracts token and sets it in store", async () => {
    const client = mockClient();
    const store = mockStore();
    (client.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      accessToken: "tok_new",
      expiresIn: 900,
      user: { id: "u1", email: "t@t.com", name: "Test", userType: "producer", orgId: null, roles: [], createdAt: "" },
    });

    const api = createAuthApi({ client, store });
    const result = await api.verifyOtp("t@t.com", "123456");

    expect(result.accessToken).toBe("tok_new");
    expect(result.user.id).toBe("u1");
    expect(store.setAccessToken).toHaveBeenCalledWith("tok_new", 900);
  });

  it("does not apply full /auth/me validation to sparse verify-otp user", async () => {
    const client = mockClient();
    const store = mockStore();
    (client.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      accessToken: "tok_sparse",
      expiresIn: 900,
      user: {
        id: "u1",
        email: "t@t.com",
        name: "Test",
        userType: "producer",
        orgId: null,
        roles: [],
      },
    });

    const api = createAuthApi({ client, store });
    await expect(api.verifyOtp("t@t.com", "123456")).resolves.toMatchObject({
      user: { id: "u1" },
    });
  });

  it("verifyOtp extracts token from nested response shapes", async () => {
    const client = mockClient();
    const store = mockStore();
    (client.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { access_token: "tok_nested" },
      expiresIn: 600,
      user: { id: "u2", email: "t@t.com", name: "Test", userType: "importer", orgId: null, roles: [], createdAt: "" },
    });

    const api = createAuthApi({ client, store });
    const result = await api.verifyOtp("t@t.com", "654321");

    expect(result.accessToken).toBe("tok_nested");
    expect(store.setAccessToken).toHaveBeenCalledWith("tok_nested", 600);
  });

  it("verifyOtp throws AuthError when no token found", async () => {
    const client = mockClient();
    const store = mockStore();
    (client.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      noTokenHere: true,
      user: { id: "u1", email: "t@t.com", name: "Test", userType: "producer", orgId: null, roles: [], createdAt: "" },
    });

    const api = createAuthApi({ client, store });

    await expect(api.verifyOtp("t@t.com", "000000")).rejects.toThrow(AuthError);
    expect(store.setAccessToken).not.toHaveBeenCalled();
  });

  it("getMe calls GET /auth/me with explicit token", async () => {
    const client = mockClient();
    (client.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "u1",
      email: "t@t.com",
      name: "Test",
      userType: "producer",
      orgId: null,
      roles: [],
      createdAt: "",
    });

    const api = createAuthApi({ client, store: mockStore() });
    const user = await api.getMe("tok_explicit");

    expect(user.id).toBe("u1");
    const callArgs = (client.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const opts = callArgs[1] as RequestInit & { skipAuth?: boolean };
    expect(opts.skipAuth).toBe(true);
    const headers = opts.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok_explicit");
  });

  it("getMe without resolver uses explicit no-refresh transport", async () => {
    const client = mockClient();
    (client.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "u1",
      email: "t@t.com",
      name: "Test",
      userType: "producer",
      orgId: null,
      roles: [],
      createdAt: "",
    });

    const api = createAuthApi({ client, store: mockStore() });
    await api.getMe();

    const callArgs = (client.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const opts = callArgs[1] as RequestInit & { skipAuth?: boolean };
    expect(opts.skipAuth).toBe(true);
  });

  it("current-token getMe shares an active identity read then revalidates", async () => {
    let resolveFirst!: (value: Response) => void;
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fullUser = {
      id: "u1",
      email: "t@t.com",
      name: "Test",
      userType: "producer" as const,
      orgId: "org_1",
      roles: ["member"],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ...fullUser, roles: [] }),
      });
    global.fetch = fetchMock as typeof fetch;
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    const client = mockClient();
    const api = createAuthApi({ client, store });

    store.setAccessToken("tok_current", 900);
    const joined = api.getMe("tok_current");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFirst({
      ok: true,
      status: 200,
      json: () => Promise.resolve(fullUser),
    } as Response);
    await expect(joined).resolves.toMatchObject({ roles: ["member"] });

    await expect(api.getMe("tok_current")).resolves.toMatchObject({ roles: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(client.fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed explicit-token /auth/me without refreshing", async () => {
    const client = mockClient();
    (client.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "u1",
      email: "t@t.com",
      name: "Test",
      userType: "producer",
      roles: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const store = mockStore();
    const api = createAuthApi({ client, store });

    await expect(api.getMe("tok_external")).rejects.toMatchObject({
      status: 503,
      code: "AUTHORITY_UNAVAILABLE",
    });
    expect(store.ensureAccessToken).not.toHaveBeenCalled();
  });

  it("logout calls POST /auth/logout", async () => {
    const client = mockClient();
    const api = createAuthApi({ client, store: mockStore() });
    await api.logout();

    expect(client.fetch).toHaveBeenCalledWith(
      "/auth/logout",
      expect.objectContaining({ method: "POST", skipAuth: true }),
    );
  });
});
