import { describe, it, expect, vi } from "vitest";
import { createAuthApi } from "../src/auth-api.js";
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

  it("getMe calls GET /auth/me without explicit token (uses client auth)", async () => {
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
    expect(opts.skipAuth).toBeUndefined();
  });

  it("logout calls POST /auth/logout", async () => {
    const client = mockClient();
    const api = createAuthApi({ client, store: mockStore() });
    await api.logout();

    expect(client.fetch).toHaveBeenCalledWith(
      "/auth/logout",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
