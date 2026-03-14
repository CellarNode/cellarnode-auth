import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAuthClient } from "../src/auth-client.js";
import { AuthError } from "../src/types.js";
import type { AuthStore } from "../src/types.js";

function mockStore(token: string | null = "tok_123"): AuthStore {
  return {
    getAccessToken: vi.fn().mockReturnValue(token),
    hasAccessToken: vi.fn().mockReturnValue(token !== null),
    setAccessToken: vi.fn(),
    clearAccessToken: vi.fn(),
    ensureAccessToken: vi.fn().mockResolvedValue(token),
  };
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
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: "ok" }),
    });

    const client = createAuthClient({ baseUrl: "http://localhost:4000", store });
    await client.fetch("/some/path");

    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:4000/some/path",
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
    const callArgs = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = callArgs[1].headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer tok_abc");
  });

  it("skips Bearer token when skipAuth is true", async () => {
    const store = mockStore("tok_abc");
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: "ok" }),
    });

    const client = createAuthClient({ baseUrl: "http://localhost:4000", store });
    await client.fetch("/auth/register", { skipAuth: true });

    const callArgs = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = callArgs[1].headers as Headers;
    expect(headers.get("Authorization")).toBeNull();
  });

  it("prepends baseUrl to paths", async () => {
    const store = mockStore("tok_abc");
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    const client = createAuthClient({ baseUrl: "http://localhost:4000", store });
    await client.fetch("/auth/me");

    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:4000/auth/me",
      expect.anything(),
    );
  });

  it("retries once on 401 with refresh", async () => {
    const store = mockStore("tok_old");
    (store.ensureAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue("tok_new");

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: "Unauthorized", code: "UNAUTHORIZED" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: "success" }),
      });

    const client = createAuthClient({ baseUrl: "http://localhost:4000", store });
    const result = await client.fetch<{ data: string }>("/api/me");

    expect(result.data).toBe("success");
    expect(store.ensureAccessToken).toHaveBeenCalledWith(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("calls onAuthFailure when refresh fails on 401", async () => {
    const store = mockStore("tok_old");
    (store.ensureAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: "Unauthorized", code: "UNAUTHORIZED" }),
    });

    const onAuthFailure = vi.fn();
    const client = createAuthClient({ baseUrl: "http://localhost:4000", store, onAuthFailure });

    await expect(client.fetch("/api/me")).rejects.toThrow(AuthError);
    expect(onAuthFailure).toHaveBeenCalled();
    expect(store.clearAccessToken).toHaveBeenCalled();
  });

  it("throws AuthError with code and remainingAttempts on non-401 errors", async () => {
    const store = mockStore(null);
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () =>
        Promise.resolve({
          error: "Invalid OTP code",
          code: "OTP_INVALID",
          remainingAttempts: 2,
        }),
    });

    const client = createAuthClient({ baseUrl: "http://localhost:4000", store });

    try {
      await client.fetch("/auth/verify-otp", { skipAuth: true });
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      const authErr = err as AuthError;
      expect(authErr.status).toBe(400);
      expect(authErr.code).toBe("OTP_INVALID");
      expect(authErr.message).toBe("Invalid OTP code");
      expect(authErr.remainingAttempts).toBe(2);
    }
  });
});
