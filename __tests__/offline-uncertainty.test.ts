import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthStore } from "../src/auth-store.js";
import type { AuthUser } from "../src/types.js";

/**
 * CEL-2123 — a scheduled renewal hangs as the network drops; the 4s bound
 * aborts it and records a possibly-committed rotation. While the browser is
 * offline the tab must neither present the refresh cookie nor sign the user
 * out: it stays `unavailable` and decides once it is back online (fail closed
 * past the commit window, re-present inside it).
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

const ok = (body: unknown) =>
  ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(body) }) as unknown as Response;

function setup() {
  let online = true;
  const win = new EventTarget();
  vi.stubGlobal("window", win);
  vi.stubGlobal("navigator", {
    get onLine() {
      return online;
    },
  });
  const refreshCalls: number[] = [];
  global.fetch = vi.fn((url: string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/auth/me") {
      return online ? Promise.resolve(ok(user)) : Promise.reject(new TypeError("Failed to fetch"));
    }
    if (path === "/auth/refresh") {
      refreshCalls.push(Date.now());
      if (refreshCalls.length === 1) {
        // In flight when the network drops: never answers; the 4s bound aborts it.
        online = false;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }
      if (!online) return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve(ok({ accessToken: "tok_b", expiresIn: 900 }));
    }
    return Promise.reject(new TypeError(`unrouted ${path}`));
  }) as typeof fetch;
  const goOnline = () => {
    online = true;
    win.dispatchEvent(new Event("online"));
  };
  return { refreshCalls, goOnline };
}

async function readyStore() {
  const store = createAuthStore({ baseUrl: "http://localhost:4000", refreshBuffer: 60 });
  store.setAccessToken("tok_a", 900);
  expect((await store.resolveSession({ refresh: false })).status).toBe("ready");
  return store;
}

describe("offline during a possibly-committed rotation (CEL-2123)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("stays unavailable for as long as the browser is offline and never presents or signs out", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { refreshCalls } = setup();
    const store = await readyStore();

    await vi.advanceTimersByTimeAsync(840_000); // scheduled renewal hangs; network drops
    await vi.advanceTimersByTimeAsync(4_000); // 4s bound: possibly committed
    await vi.advanceTimersByTimeAsync(180_000); // three minutes offline

    expect(store.getSessionState().status).toBe("unavailable");
    expect(refreshCalls).toHaveLength(1); // the cookie was never presented again

    // Even an explicit "Try again" while offline holds instead of deciding.
    const resolution = await store.resolveSession({ refresh: true });
    expect(resolution.status).toBe("unavailable");
    expect(refreshCalls).toHaveLength(1);
  });

  it("fails closed once back online past the commit window, without presenting the cookie", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { refreshCalls, goOnline } = setup();
    const store = await readyStore();

    await vi.advanceTimersByTimeAsync(840_000 + 4_000 + 120_000);
    goOnline();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.getSessionState()).toMatchObject({
      status: "unauthorized",
      reason: "session-uncertain",
    });
    expect(refreshCalls).toHaveLength(1);
  });

  it("re-presents and recovers when back online inside the commit window", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { refreshCalls, goOnline } = setup();
    const store = await readyStore();

    await vi.advanceTimersByTimeAsync(840_000 + 4_000); // timed out at send + 4s
    await vi.advanceTimersByTimeAsync(2_000); // still offline, still inside the 8s window
    expect(store.getSessionState().status).toBe("unavailable");
    goOnline(); // send + 6s
    await vi.advanceTimersByTimeAsync(0);

    expect(refreshCalls).toHaveLength(2);
    expect(refreshCalls[1]! - refreshCalls[0]!).toBeLessThan(8_000);
    expect(store.getSessionState()).toMatchObject({ status: "ready", token: "tok_b" });
  });
});

describe("offline hold lifecycle (CEL-2123 review P3)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("a cold hold (reload offline inside the uncertainty) still decides on `online`", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    // The uncertainty survives a reload through the shared localStorage.
    const map = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: () => null,
      get length() {
        return map.size;
      },
    } as Storage);
    const { refreshCalls, goOnline } = setup();
    const store = await readyStore();
    await vi.advanceTimersByTimeAsync(840_000 + 4_000); // possibly committed, offline

    // A reload: a new store with no in-memory token, while still offline.
    const cold = createAuthStore({ baseUrl: "http://localhost:4000", refreshBuffer: 60 });
    expect((await cold.resolveSession({ refresh: true })).status).not.toBe("ready");
    await vi.advanceTimersByTimeAsync(60_000); // past the window
    goOnline();
    await vi.advanceTimersByTimeAsync(0);

    expect(cold.getSessionState()).toMatchObject({ status: "unauthorized", reason: "session-uncertain" });
    expect(refreshCalls).toHaveLength(1);
    void store;
  });

  it("a sign-out and new sign-in while offline cancel the hold: the new session is not rotated on `online`", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { refreshCalls, goOnline } = setup();
    const store = await readyStore();
    await vi.advanceTimersByTimeAsync(840_000 + 4_000 + 10_000); // held, offline

    store.clearAccessToken(); // sign-out
    store.setAccessToken("tok_new", 900); // sign-in (supersedes the uncertainty)
    await vi.advanceTimersByTimeAsync(0);
    goOnline();
    await vi.advanceTimersByTimeAsync(0);

    // Only the original hung renewal: nothing rotated the new session.
    expect(refreshCalls).toHaveLength(1);
  });
});

/**
 * CEL-2123 (review P2) — the network drops WHILE the refresh is in flight:
 * the server commits the rotation, the client sees a fast TypeError, not a
 * timeout. Online at send + offline at catch counts as possibly committed,
 * so the offline hold covers it. A device already offline at send is
 * unchanged: the request never left, nothing is recorded.
 */
function committingBackend(opts: { dropOnFirstPresentation: boolean }) {
  let online = true;
  const win = new EventTarget();
  vi.stubGlobal("window", win);
  vi.stubGlobal("navigator", {
    get onLine() {
      return online;
    },
  });
  const presentedAt: number[] = [];
  let committedAt: number | null = null;
  let replayed = false;
  global.fetch = vi.fn((url: string) => {
    const path = new URL(String(url)).pathname;
    if (path === "/auth/me") {
      return online ? Promise.resolve(ok(user)) : Promise.reject(new TypeError("Failed to fetch"));
    }
    if (path === "/auth/refresh") {
      if (!online) return Promise.reject(new TypeError("Failed to fetch"));
      presentedAt.push(Date.now());
      if (committedAt === null && opts.dropOnFirstPresentation) {
        // The server rotates, then the connection dies before the response.
        committedAt = Date.now();
        online = false;
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      if (committedAt === null) {
        // An ordinary first rotation that is answered.
        committedAt = Date.now();
        return Promise.resolve(ok({ accessToken: "tok_b", expiresIn: 900 }));
      }
      if (Date.now() - committedAt > 10_000) {
        replayed = true;
        return Promise.resolve({
          ok: false,
          status: 401,
          json: vi.fn().mockResolvedValue({ code: "REFRESH_REPLAYED" }),
        } as unknown as Response);
      }
      return Promise.resolve(ok({ accessToken: "tok_b", expiresIn: 900 }));
    }
    return Promise.reject(new TypeError(`unrouted ${path}`));
  }) as typeof fetch;
  return {
    presentedAt,
    replayed: () => replayed,
    goOnline: () => {
      online = true;
      win.dispatchEvent(new Event("online"));
    },
    goOffline: () => {
      online = false;
    },
  };
}

describe("a network drop mid-refresh (CEL-2123 review P2)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("holds while offline and fails closed past the window without presenting (no REFRESH_REPLAYED)", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const backend = committingBackend({ dropOnFirstPresentation: true });
    const store = await readyStore();

    await vi.advanceTimersByTimeAsync(840_000); // renewal: committed, then TypeError offline
    await vi.advanceTimersByTimeAsync(120_000); // two minutes offline
    expect(store.getSessionState().status).toBe("unavailable");
    backend.goOnline();
    await vi.advanceTimersByTimeAsync(0);

    expect(backend.presentedAt).toHaveLength(1);
    expect(backend.replayed()).toBe(false);
    expect(store.getSessionState()).toMatchObject({
      status: "unauthorized",
      reason: "session-uncertain",
    });
  });

  it("recovers when back online inside the window (the duplicate lands in the grace)", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const backend = committingBackend({ dropOnFirstPresentation: true });
    const store = await readyStore();

    await vi.advanceTimersByTimeAsync(840_000);
    await vi.advanceTimersByTimeAsync(3_000);
    backend.goOnline();
    await vi.advanceTimersByTimeAsync(0);

    expect(backend.presentedAt).toHaveLength(2);
    expect(backend.replayed()).toBe(false);
    expect(store.getSessionState()).toMatchObject({ status: "ready", token: "tok_b" });
  });

  it("offline AT SEND is unchanged: nothing recorded, the next retry presents normally", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const backend = committingBackend({ dropOnFirstPresentation: false });
    const store = await readyStore();
    backend.goOffline(); // offline BEFORE the renewal is sent

    await vi.advanceTimersByTimeAsync(840_000); // renewal: TypeError, it never left
    await vi.advanceTimersByTimeAsync(60_000); // well past any 8s window
    expect(backend.presentedAt).toHaveLength(0);
    backend.goOnline();
    await vi.advanceTimersByTimeAsync(120_000); // the backoff retry fires online

    expect(backend.presentedAt.length).toBeGreaterThanOrEqual(1);
    expect(backend.replayed()).toBe(false);
    expect(store.getSessionState()).toMatchObject({ status: "ready", token: "tok_b" });
  });
});
