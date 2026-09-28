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

/**
 * CEL-2123 (review P3) — the browser can report `offline` a moment AFTER the
 * refresh fetch rejects. A network TypeError while still online is watched
 * for LATE_OFFLINE_WATCH_MS (2s): a late `offline` counts as a drop during the
 * refresh; no event keeps the ordinary backoff.
 */
function lateDropBackend(opts: { commitFirst: boolean; offlineAfterMs: number | null }) {
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
      if (presentedAt.length === 1) {
        if (opts.commitFirst) committedAt = Date.now();
        if (opts.offlineAfterMs !== null) {
          setTimeout(() => {
            online = false;
            win.dispatchEvent(new Event("offline"));
          }, opts.offlineAfterMs);
        }
        // Rejects while navigator.onLine is still true.
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      if (committedAt !== null && Date.now() - committedAt > 10_000) {
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
  };
}

describe("a late `offline` after a refresh TypeError (CEL-2123 review P3)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("offline 50ms after the TypeError is recorded: held, then fails closed past the window without REFRESH_REPLAYED", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const backend = lateDropBackend({ commitFirst: true, offlineAfterMs: 50 });
    const store = await readyStore();

    await vi.advanceTimersByTimeAsync(840_000); // renewal: committed, TypeError while online
    await vi.advanceTimersByTimeAsync(120_000); // the late `offline` fired; two minutes offline
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

  it("an `offline` AFTER the 2s watch is not recorded: back online, the retry presents normally", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const backend = lateDropBackend({ commitFirst: false, offlineAfterMs: 3_000 });
    const store = await readyStore();

    await vi.advanceTimersByTimeAsync(840_000); // transient TypeError; offline only at +3s
    await vi.advanceTimersByTimeAsync(60_000); // well past the 8s window, still offline
    backend.goOnline();
    await vi.advanceTimersByTimeAsync(120_000); // the backoff retry fires online

    expect(backend.presentedAt.length).toBeGreaterThanOrEqual(2);
    expect(store.getSessionState()).toMatchObject({ status: "ready", token: "tok_b" });
  });

  it("cleanup: a sign-out during the watch means a later `offline` records nothing", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const backend = lateDropBackend({ commitFirst: false, offlineAfterMs: 1_000 });
    const store = await readyStore();

    await vi.advanceTimersByTimeAsync(840_000); // TypeError while online; watch starts
    store.clearAccessToken(); // sign-out at +0s, inside the watch
    store.setAccessToken("tok_new", 900); // new sign-in
    await vi.advanceTimersByTimeAsync(1_500); // `offline` fires at +1s
    backend.goOnline();
    await vi.advanceTimersByTimeAsync(0);

    // A stale watch would have armed the hold and forced a rotation of the
    // NEW session on `online`: only the original failed send was presented.
    expect(backend.presentedAt).toHaveLength(1);
  });

  it("cleanup: a new send ends the previous refresh's watch", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const backend = lateDropBackend({ commitFirst: false, offlineAfterMs: 1_500 });
    const store = await readyStore();

    await vi.advanceTimersByTimeAsync(840_000); // TypeError while online; watch starts
    // A new send (e.g. "Try again") within the watch: it succeeds online.
    const retried = await store.resolveSession({ refresh: true });
    expect(retried.status).toBe("ready");
    await vi.advanceTimersByTimeAsync(2_000); // the old refresh's `offline` fires at +1.5s
    backend.goOnline();
    await vi.advanceTimersByTimeAsync(0);

    // Nothing acted on the resolved refresh: no hold, so no forced rotation
    // on `online` (the failed send plus the successful retry only).
    expect(backend.presentedAt).toHaveLength(2);
    expect(store.getSessionState()).toMatchObject({ status: "ready", token: "tok_b" });

    // (review P3 #1) The fresh renewal timer survived the stale `offline`:
    // the next rotation happens on schedule, not earlier and not never.
    await vi.advanceTimersByTimeAsync(837_000); // 839s after the success
    expect(backend.presentedAt).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(backend.presentedAt).toHaveLength(3);
    expect(store.getSessionState().status).toBe("ready");
  });

  it("a stale in-flight refresh that dies after a new sign-in never watches for the new session (review P3 #2)", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    let online = true;
    const win = new EventTarget();
    vi.stubGlobal("window", win);
    vi.stubGlobal("navigator", {
      get onLine() {
        return online;
      },
    });
    const presentedAt: number[] = [];
    let killFirst: (() => void) | null = null;
    global.fetch = vi.fn((url: string) => {
      const path = new URL(String(url)).pathname;
      if (path === "/auth/me") {
        return online ? Promise.resolve(ok(user)) : Promise.reject(new TypeError("Failed to fetch"));
      }
      if (path === "/auth/refresh") {
        if (!online) return Promise.reject(new TypeError("Failed to fetch"));
        presentedAt.push(Date.now());
        if (presentedAt.length === 1) {
          // In flight until the test kills it with a TypeError (still online).
          return new Promise<Response>((_resolve, reject) => {
            killFirst = () => reject(new TypeError("Failed to fetch"));
          });
        }
        return Promise.resolve(ok({ accessToken: "tok_c", expiresIn: 900 }));
      }
      return Promise.reject(new TypeError(`unrouted ${path}`));
    }) as typeof fetch;
    const store = await readyStore();

    await vi.advanceTimersByTimeAsync(840_000); // renewal in flight
    expect(presentedAt).toHaveLength(1);
    store.clearAccessToken();
    store.setAccessToken("tok_new", 900); // a new sign-in supersedes it
    await vi.advanceTimersByTimeAsync(0);
    killFirst!(); // the old request dies with a TypeError, still online
    await vi.advanceTimersByTimeAsync(50);
    online = false;
    win.dispatchEvent(new Event("offline"));
    await vi.advanceTimersByTimeAsync(1_000);
    online = true;
    win.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);

    // No hold, no forced rotation of the new session on `online`.
    expect(presentedAt).toHaveLength(1);
    expect(store.getSessionState()).toMatchObject({ status: "ready", token: "tok_new" });
    // The new session's own renewal timer is intact and fires on schedule.
    await vi.advanceTimersByTimeAsync(840_000);
    expect(presentedAt).toHaveLength(2);
    expect(store.getSessionState()).toMatchObject({ status: "ready", token: "tok_c" });
  });

  it("no `offline` within 2s is not recorded: the ordinary backoff retries and recovers", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const backend = lateDropBackend({ commitFirst: false, offlineAfterMs: null });
    const store = await readyStore();

    await vi.advanceTimersByTimeAsync(840_000); // renewal: transient TypeError, still online
    await vi.advanceTimersByTimeAsync(30_000);

    expect(backend.presentedAt.length).toBeGreaterThanOrEqual(2);
    // Not the 1.5s possibly-committed quick retry: the normal >= 4s backoff.
    expect(backend.presentedAt[1]! - backend.presentedAt[0]!).toBeGreaterThanOrEqual(4_000);
    expect(store.getSessionState()).toMatchObject({ status: "ready", token: "tok_b" });
  });
});
