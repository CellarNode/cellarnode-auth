import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAuthStore } from "../src/auth-store.js";

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
