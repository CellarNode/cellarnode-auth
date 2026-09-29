import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthStore } from "../src/auth-store.js";
import type { AuthUser } from "../src/types.js";

/**
 * CEL-2124 — a lost refresh must not sign the tab out, and must not let the
 * old cookie be posted once the probe says that would be a replay.
 *
 * Probe body contract (assumed; the server is not in this package):
 * `{ status: "committed" | "not-committed" | "revoked" | "expired" }`.
 * HTTP 429 is inconclusive and sets no successor.
 */

const user: AuthUser = {
  id: "user_1",
  email: "u@example.test",
  name: "U",
  userType: "importer",
  orgId: "org_a",
  roles: ["member"],
  entitlements: ["importer-dashboard"],
  createdAt: "2026-01-01T00:00:00.000Z",
};

const API = "http://localhost:4000";
const ATTEMPT_KEY = `cellarnode:auth:default:${API}:refresh-attempt-id`;
const COMMITTED_KEY = `cellarnode:auth:default:${API}:possibly-committed-at`;
const SUPPRESSED_KEY = `cellarnode:auth:default:${API}:refresh-presentation-suppressed`;

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function header(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

function memoryStorage() {
  const map = new Map<string, string>();
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as Storage;
  return { map, storage };
}

describe("refresh attempt probe (CEL-2124)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function install(options: {
    probe?: () => Promise<Response>;
    refreshAfterLoss?: () => Promise<Response>;
    online?: () => boolean;
    releaseRefreshAfterProbe?: boolean;
  }) {
    const calls: { path: string; init?: RequestInit }[] = [];
    let probed = false;
    const win = new EventTarget();
    vi.stubGlobal("window", win);
    vi.stubGlobal("navigator", {
      get onLine() {
        return options.online ? options.online() : true;
      },
    });
    const hang = (init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    global.fetch = vi.fn((url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, init });
      if (path === "/auth/me") return Promise.resolve(response(user));
      if (path === "/auth/refresh-probe") {
        probed = true;
        return options.probe
          ? options.probe()
          : Promise.resolve(response({ status: "expired" }));
      }
      if (path === "/auth/refresh") {
        const release = options.releaseRefreshAfterProbe === false ? false : probed;
        if (!release) return hang(init);
        return options.refreshAfterLoss
          ? options.refreshAfterLoss()
          : Promise.resolve(response({ accessToken: "tok_b", expiresIn: 900 }));
      }
      return Promise.reject(new TypeError(`unrouted ${path}`));
    }) as typeof fetch;
    return {
      calls,
      goOnline: () => win.dispatchEvent(new Event("online")),
      refreshes: () => calls.filter((call) => call.path === "/auth/refresh"),
      probes: () => calls.filter((call) => call.path === "/auth/refresh-probe"),
    };
  }

  async function lostRefresh(storage: Storage) {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    vi.stubGlobal("localStorage", storage);
    const store = createAuthStore({ baseUrl: API, refreshBuffer: 60 });
    store.setAccessToken("tok_a", 900);
    expect((await store.resolveSession({ refresh: false })).status).toBe("ready");
    await vi.advanceTimersByTimeAsync(840_000);
    await vi.advanceTimersByTimeAsync(4_000);
    return store;
  }

  it("sends a random attempt id and persists it beside possibly-committed-at", async () => {
    const { storage } = memoryStorage();
    const backend = install({});
    const store = await lostRefresh(storage);

    const first = backend.refreshes()[0];
    const attemptId = header(first?.init, "X-Refresh-Attempt");
    expect(attemptId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(storage.getItem(ATTEMPT_KEY)).toBe(attemptId);
    expect(storage.getItem(COMMITTED_KEY)).toMatch(/^\d+$/);
    expect(store.getSessionState().status).toBe("unavailable");
  });

  it("reuses the persisted attempt id on an in-window retry", async () => {
    const { storage } = memoryStorage();
    const backend = install({});
    await lostRefresh(storage);
    await vi.advanceTimersByTimeAsync(2_000);

    const [first, second] = backend.refreshes();
    expect(header(second?.init, "X-Refresh-Attempt")).toBe(
      header(first?.init, "X-Refresh-Attempt"),
    );
    expect(backend.probes()).toHaveLength(0);
  });

  it("committed: clears uncertainty and refreshes the successor the probe set", async () => {
    const { storage } = memoryStorage();
    const backend = install({
      probe: () => Promise.resolve(response({ status: "committed" })),
    });
    const store = await lostRefresh(storage);
    const ended = vi.spyOn(store, "endSessionUncertainty");
    await vi.advanceTimersByTimeAsync(120_000);

    expect(backend.probes()).toHaveLength(1);
    expect(header(backend.probes()[0]?.init, "X-Refresh-Attempt")).toBe(
      storage.getItem(ATTEMPT_KEY) ?? header(backend.refreshes()[0]?.init, "X-Refresh-Attempt"),
    );
    expect(backend.refreshes().length).toBeGreaterThanOrEqual(2);
    expect(header(backend.refreshes().at(-1)?.init, "X-Refresh-Attempt")).not.toBe(
      header(backend.refreshes()[0]?.init, "X-Refresh-Attempt"),
    );
    expect(storage.getItem(COMMITTED_KEY)).toBeNull();
    expect(storage.getItem(ATTEMPT_KEY)).toBeNull();
    expect(ended).not.toHaveBeenCalled();
    expect(store.getSessionState()).toMatchObject({ status: "ready", token: "tok_b" });
    expect(store.getAccessToken()).toBe("tok_b");
  });

  it("not committed: retries the original refresh and does not sign out", async () => {
    const { storage } = memoryStorage();
    const backend = install({
      probe: () => Promise.resolve(response({ status: "not-committed" })),
    });
    const store = await lostRefresh(storage);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(backend.probes()).toHaveLength(1);
    expect(backend.refreshes().length).toBeGreaterThanOrEqual(2);
    expect(store.getSessionState()).toMatchObject({ status: "ready", token: "tok_b" });
    expect(store.getSessionState()).not.toMatchObject({ status: "unauthorized" });
  });

  it("a 401 for an attempt the server never stored retries the refresh", async () => {
    const { storage } = memoryStorage();
    const backend = install({
      probe: () =>
        Promise.resolve(
          response({ error: "Unknown refresh attempt", code: "INVALID_REFRESH_ATTEMPT" }, 401),
        ),
    });
    const store = await lostRefresh(storage);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(backend.probes()).toHaveLength(1);
    expect(backend.refreshes().length).toBeGreaterThanOrEqual(2);
    expect(store.getSessionState()).toMatchObject({ status: "ready", token: "tok_b" });
  });

  it.each(["revoked", "expired"] as const)(
    "%s: ends uncertainty and does not post the old cookie to refresh",
    async (status) => {
      const { storage } = memoryStorage();
      const backend = install({
        probe: () => Promise.resolve(response({ status })),
      });
      const store = await lostRefresh(storage);
      const ended = vi.spyOn(store, "endSessionUncertainty");
      await vi.advanceTimersByTimeAsync(120_000);

      expect(ended).toHaveBeenCalledTimes(1);
      expect(backend.probes()).toHaveLength(1);
      const probeAt = backend.calls.findIndex((call) => call.path === "/auth/refresh-probe");
      expect(
        backend.calls.filter((call, index) => index > probeAt && call.path === "/auth/refresh"),
      ).toHaveLength(0);
      expect(storage.getItem(COMMITTED_KEY)).toBeNull();
      expect(storage.getItem(ATTEMPT_KEY)).toBeNull();
      expect(storage.getItem(SUPPRESSED_KEY)).toBe("1");
      expect(store.getSessionState()).toEqual({
        status: "unauthorized",
        reason: "session-uncertain",
      });

      const presented = backend.refreshes().length;
      await store.resolveSession({ refresh: true });
      await createAuthStore({ baseUrl: API, refreshBuffer: 60 }).resolveSession({
        refresh: true,
      });
      expect(backend.refreshes()).toHaveLength(presented);
      expect(backend.probes()).toHaveLength(1);
    },
  );

  it("a client with no attempt id keeps today's fail-closed behavior", async () => {
    vi.useFakeTimers();
    const { storage } = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    storage.setItem(COMMITTED_KEY, String(Date.now() - 60_000));
    const calls: string[] = [];
    global.fetch = vi.fn((url: string) => {
      calls.push(new URL(String(url)).pathname);
      if (new URL(String(url)).pathname === "/auth/me") {
        return Promise.resolve(response(user));
      }
      return Promise.resolve(response({ accessToken: "tok_b", expiresIn: 900 }));
    }) as typeof fetch;
    const store = createAuthStore({ baseUrl: API, refreshBuffer: 60 });
    store.setAccessToken("tok_a", 900);
    expect((await store.resolveSession({ refresh: false })).status).toBe("ready");
    storage.setItem(COMMITTED_KEY, String(Date.now() + 60_000));
    storage.removeItem(ATTEMPT_KEY);

    await expect(store.resolveSession({ refresh: true })).resolves.toEqual({
      status: "unauthorized",
    });
    expect(store.getSessionState()).toEqual({
      status: "unauthorized",
      reason: "session-uncertain",
    });
    expect(calls).not.toContain("/auth/refresh");
    expect(calls).not.toContain("/auth/refresh-probe");
    expect(storage.getItem(COMMITTED_KEY)).not.toBeNull();
  });

  it("reconnect probes before presenting, then refreshes when the probe says committed", async () => {
    let online = true;
    const { storage } = memoryStorage();
    const backend = install({
      online: () => online,
      probe: () => Promise.resolve(response({ status: "committed" })),
    });
    const store = await lostRefresh(storage);
    online = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(backend.probes()).toHaveLength(0);
    expect(backend.refreshes()).toHaveLength(1);
    expect(store.getSessionState().status).toBe("unavailable");

    online = true;
    backend.goOnline();
    await vi.advanceTimersByTimeAsync(0);

    expect(backend.probes()).toHaveLength(1);
    expect(backend.calls.filter((call) => call.path === "/auth/refresh-probe").length).toBe(1);
    const probeAt = backend.calls.findIndex((call) => call.path === "/auth/refresh-probe");
    const refreshAfter = backend.calls.findIndex(
      (call, index) => index > probeAt && call.path === "/auth/refresh",
    );
    expect(refreshAfter).toBeGreaterThan(probeAt);
    expect(store.getSessionState()).toMatchObject({ status: "ready", token: "tok_b" });
  });

  it("a 429 probe past the window does not sign out and does not refresh", async () => {
    const { storage } = memoryStorage();
    const backend = install({
      probe: () => Promise.resolve(response({ status: "committed" }, 429)),
    });
    const store = await lostRefresh(storage);
    const ended = vi.spyOn(store, "endSessionUncertainty");
    await vi.advanceTimersByTimeAsync(120_000);

    expect(backend.probes().length).toBeGreaterThanOrEqual(1);
    const probeAt = backend.calls.findIndex((call) => call.path === "/auth/refresh-probe");
    expect(
      backend.calls.filter((call, index) => index > probeAt && call.path === "/auth/refresh"),
    ).toHaveLength(0);
    expect(ended).not.toHaveBeenCalled();
    expect(store.getAccessToken()).toBe("tok_a");
    expect(store.getSessionState().status).toBe("unavailable");
  });

  it("sends the family header on the probe when the store declares one", async () => {
    const { storage } = memoryStorage();
    const calls: { path: string; init?: RequestInit }[] = [];
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    vi.stubGlobal("localStorage", storage);
    global.fetch = vi.fn((url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, init });
      if (path === "/auth/me") return Promise.resolve(response(user));
      if (path === "/auth/refresh-probe") {
        return Promise.resolve(response({ status: "not-committed" }));
      }
      if (path === "/auth/refresh") {
        if (!calls.some((call) => call.path === "/auth/refresh-probe")) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          });
        }
        return Promise.resolve(response({ accessToken: "tok_b", expiresIn: 900 }));
      }
      return Promise.reject(new TypeError(`unrouted ${path}`));
    }) as typeof fetch;

    const store = createAuthStore({
      baseUrl: API,
      refreshBuffer: 60,
      productFamily: "producer",
    });
    store.setAccessToken("tok_a", 900);
    await store.resolveSession({ refresh: false });
    await vi.advanceTimersByTimeAsync(840_000 + 120_000);

    const probe = calls.find((call) => call.path === "/auth/refresh-probe");
    const lost = calls.find((call) => call.path === "/auth/refresh");
    expect(header(probe?.init, "X-CellarNode-Family")).toBe("producer");
    expect(header(probe?.init, "X-Refresh-Attempt")).toBe(
      header(lost?.init, "X-Refresh-Attempt"),
    );
  });
});
