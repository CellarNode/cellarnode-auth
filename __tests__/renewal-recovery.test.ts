import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthApi } from "../src/auth-api.js";
import { createAuthClient } from "../src/auth-client.js";
import { createAuthStore } from "../src/auth-store.js";
import type { AuthUser, SessionState } from "../src/types.js";

/**
 * CEL-2107 — recovery after a renewal fails on the network (QA of CEL-2086).
 *
 * 1. A `/auth/me` 401 on a confirmed session whose token was not just rotated
 *    (an access token that expired while its renewal could not run) asks the
 *    refresh cookie before signing out. Only a refused rotation is
 *    `unauthorized`; a rotation that fails on the network stays `unavailable`.
 * 2. A failed scheduled renewal is retried on a bounded backoff.
 * 3. `revalidateSession()` ("Try again") renews while a renewal is owed,
 *    because a remint keeps the old expiry.
 */

const userA: AuthUser = {
  id: "user_1",
  email: "user@example.test",
  name: "User",
  userType: "producer",
  orgId: "org_a",
  roles: ["member"],
  entitlements: ["producer-dashboard"],
  createdAt: "2026-01-01T00:00:00.000Z",
};

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

type Route = (init?: RequestInit) => Promise<Response>;

/** Routes fetch by path; records every call's path in order. */
function routeFetch(routes: {
  me: Route;
  refresh?: Route;
  revalidate?: Route;
}): string[] {
  const calls: string[] = [];
  global.fetch = vi.fn((url: string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (path === "/auth/me") return routes.me(init);
    if (path === "/auth/refresh" && routes.refresh) return routes.refresh(init);
    if (path === "/auth/revalidate" && routes.revalidate) return routes.revalidate(init);
    // CEL-2124 — these suites predate the probe. A lost refresh now asks
    // before failing closed; expired keeps the old "do not present" outcome.
    if (path === "/auth/refresh-probe") {
      return Promise.resolve(response({ status: "expired" }));
    }
    return Promise.reject(new TypeError(`unrouted ${path}`));
  }) as typeof fetch;
  return calls;
}

const bearer = (init?: RequestInit) =>
  new Headers(init?.headers).get("Authorization")?.slice(7) ?? "";

async function readySession(store: ReturnType<typeof createAuthStore>) {
  store.setAccessToken("tok_a", 900);
  const ready = await store.resolveSession({ refresh: false });
  expect(ready.status).toBe("ready");
}

describe("renewal recovery (CEL-2107)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("an expired token whose rotation fails on the network stays unavailable, never signs out", async () => {
    let expired = false;
    const calls = routeFetch({
      me: () =>
        Promise.resolve(expired ? response({ code: "UNAUTHORIZED" }, 401) : response(userA)),
      refresh: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    await readySession(store);
    const states: SessionState["status"][] = [];
    store.onSessionStateChange((state) => states.push(state.status));

    expired = true;
    const result = await store.resolveSession({ refresh: false });

    expect(result).toEqual({ status: "unavailable", token: "tok_a" });
    expect(store.getAccessToken()).toBe("tok_a");
    expect(states).not.toContain("unauthorized");
    expect(calls.filter((c) => c === "/auth/refresh")).toHaveLength(1);
  });

  it("an expired token recovers through the refresh cookie when rotation succeeds", async () => {
    let expired = false;
    routeFetch({
      me: (init) =>
        Promise.resolve(
          expired && bearer(init) === "tok_a"
            ? response({ code: "UNAUTHORIZED" }, 401)
            : response(userA),
        ),
      refresh: () => Promise.resolve(response({ accessToken: "tok_b", expiresIn: 900 })),
    });
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    await readySession(store);

    expired = true;
    const result = await store.resolveSession({ refresh: false });

    expect(result).toMatchObject({ status: "ready", token: "tok_b" });
    expect(store.getAccessToken()).toBe("tok_b");
  });

  it("an expired token whose rotation is refused signs out", async () => {
    let expired = false;
    routeFetch({
      me: () =>
        Promise.resolve(expired ? response({ code: "UNAUTHORIZED" }, 401) : response(userA)),
      refresh: () => Promise.resolve(response({ code: "UNAUTHORIZED" }, 401)),
    });
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    await readySession(store);

    expired = true;
    const result = await store.resolveSession({ refresh: false });

    expect(result).toEqual({ status: "unauthorized" });
    expect(store.getAccessToken()).toBeNull();
  });

  it("retries a failed scheduled renewal on a backoff until it succeeds", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter factor 1.0
    let refreshOnline = false;
    const calls = routeFetch({
      me: () => Promise.resolve(response(userA)),
      refresh: () =>
        refreshOnline
          ? Promise.resolve(response({ accessToken: "tok_b", expiresIn: 900 }))
          : Promise.reject(new TypeError("Failed to fetch")),
    });
    const store = createAuthStore({ baseUrl: "http://localhost:4000", refreshBuffer: 60 });
    await readySession(store);

    // The scheduled renewal fires (900s - 60s buffer) and fails on the network.
    await vi.advanceTimersByTimeAsync(840_000);
    expect(calls.filter((c) => c === "/auth/refresh")).toHaveLength(1);
    expect(store.getSessionState().status).toBe("unavailable");

    // First backoff step (5s) retries while still offline…
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.filter((c) => c === "/auth/refresh")).toHaveLength(2);

    // …the next step (15s) runs once the network is back and recovers.
    refreshOnline = true;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls.filter((c) => c === "/auth/refresh")).toHaveLength(3);
    expect(store.getSessionState()).toMatchObject({ status: "ready", token: "tok_b" });
  });

  it("revalidateSession renews (not remints) while a renewal is owed", async () => {
    vi.useFakeTimers();
    let refreshOnline = false;
    const calls = routeFetch({
      me: () => Promise.resolve(response(userA)),
      refresh: () =>
        refreshOnline
          ? Promise.resolve(response({ accessToken: "tok_b", expiresIn: 900 }))
          : Promise.reject(new TypeError("Failed to fetch")),
      revalidate: () => Promise.resolve(response({ accessToken: "tok_remint" })),
    });
    const store = createAuthStore({ baseUrl: "http://localhost:4000", refreshBuffer: 60 });
    await readySession(store);
    await vi.advanceTimersByTimeAsync(840_000);
    expect(store.getSessionState().status).toBe("unavailable");

    refreshOnline = true;
    const result = await store.revalidateSession();

    expect(result).toMatchObject({ status: "ready", token: "tok_b" });
    expect(calls).not.toContain("/auth/revalidate");
  });

  it("revalidateSession still remints when no renewal is owed", async () => {
    const calls = routeFetch({
      me: () => Promise.resolve(response(userA)),
      revalidate: () => Promise.resolve(response({ accessToken: "tok_remint" })),
    });
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    await readySession(store);

    const result = await store.revalidateSession();

    expect(result).toMatchObject({ status: "ready", token: "tok_remint" });
    expect(calls).toContain("/auth/revalidate");
    expect(calls).not.toContain("/auth/refresh");
  });

  /** A session whose scheduled renewal just failed on the network. */
  async function failedRenewal(options: { online?: () => boolean } = {}) {
    const calls = routeFetch({
      me: () => Promise.resolve(response(userA)),
      refresh: () =>
        options.online?.()
          ? Promise.resolve(response({ accessToken: "tok_b", expiresIn: 900 }))
          : Promise.reject(new TypeError("Failed to fetch")),
    });
    const store = createAuthStore({ baseUrl: "http://localhost:4000", refreshBuffer: 60 });
    await readySession(store);
    await vi.advanceTimersByTimeAsync(840_000);
    expect(store.getSessionState().status).toBe("unavailable");
    const refreshes = () => calls.filter((c) => c === "/auth/refresh").length;
    return { store, refreshes };
  }

  it("jitters the retry delay (±20%) so tabs that failed together do not retry in lockstep", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.999); // +20% → ~6s
    const { refreshes } = await failedRenewal();
    await vi.advanceTimersByTimeAsync(5_900);
    expect(refreshes()).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(refreshes()).toBe(2);
  });

  it("a hidden tab defers its retry until it is visible again", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const doc = Object.assign(new EventTarget(), { visibilityState: "hidden" });
    vi.stubGlobal("document", doc);
    let online = false;
    const { store, refreshes } = await failedRenewal({ online: () => online });

    await vi.advanceTimersByTimeAsync(120_000);
    expect(refreshes()).toBe(1); // nothing while hidden

    online = true;
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshes()).toBe(2);
    expect(store.getSessionState()).toMatchObject({ status: "ready", token: "tok_b" });
  });

  it("stops retrying after sign-out", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { store, refreshes } = await failedRenewal();
    store.clearAccessToken();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(refreshes()).toBe(1);
  });

  it("stops retrying once a rotation is refused (unauthorized)", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    let refused = false;
    const calls = routeFetch({
      me: () => Promise.resolve(response(userA)),
      refresh: () =>
        refused
          ? Promise.resolve(response({ code: "UNAUTHORIZED" }, 401))
          : Promise.reject(new TypeError("Failed to fetch")),
    });
    const store = createAuthStore({ baseUrl: "http://localhost:4000", refreshBuffer: 60 });
    await readySession(store);
    await vi.advanceTimersByTimeAsync(840_000);
    refused = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.getSessionState().status).toBe("unauthorized");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(calls.filter((c) => c === "/auth/refresh")).toHaveLength(2);
  });

  it("a retry never stacks with the scheduled renewal timer", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    let online = false;
    const { refreshes } = await failedRenewal({ online: () => online });
    online = true;
    // The retry at +5s succeeds and schedules the next renewal (900s - 60s);
    // no second timer fires in between.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(refreshes()).toBe(2);
    await vi.advanceTimersByTimeAsync(839_000);
    expect(refreshes()).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refreshes()).toBe(3);
  });

  // CEL-2107 P4 — an account change in another tab ends this identity (fail
  // closed, as before) but says why, so the app can reload into the new
  // workspace instead of sending the user to sign-in.
  it("marks a post-rotation user divergence as account-changed", async () => {
    let switched = false;
    routeFetch({
      me: () => Promise.resolve(response(switched ? { ...userA, id: "user_2" } : userA)),
      refresh: () => Promise.resolve(response({ accessToken: "tok_b", expiresIn: 900 })),
    });
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    await readySession(store);
    const states: SessionState[] = [];
    store.onSessionStateChange((state) => states.push(state));

    switched = true; // another tab signed in as user_2 (shared refresh cookie)
    await store.resolveSession({ refresh: true });

    expect(states.at(-1)).toEqual({ status: "unauthorized", reason: "account-changed" });
    expect(store.getAccessToken()).toBeNull();
  });

  it("a same-token divergence or an ordinary sign-out carries no reason", async () => {
    let switched = false;
    routeFetch({ me: () => Promise.resolve(response(switched ? { ...userA, id: "user_2" } : userA)) });
    const store = createAuthStore({ baseUrl: "http://localhost:4000" });
    await readySession(store);
    const states: SessionState[] = [];
    store.onSessionStateChange((state) => states.push(state));

    switched = true;
    await store.resolveSession({ refresh: false });
    expect(states.at(-1)).toEqual({ status: "unauthorized" });

    await readySession(store);
    store.clearAccessToken();
    expect(states.at(-1)).toEqual({ status: "unauthorized" });
  });

  // Review P2 — a refresh the server COMMITTED but whose response was lost
  // must be re-presented inside the backend's 10s grace (from rotatedAt),
  // where it is an idempotent duplicate. Outside it is REFRESH_REPLAYED and
  // the whole family is revoked on every device.
  function graceBackend() {
    const GRACE_MS = 10_000;
    let committedAt: number | null = null;
    const presentedAt: number[] = [];
    const refresh: Route = (init) => {
      presentedAt.push(Date.now());
      if (committedAt === null) {
        // First presentation: the server commits the rotation at once but
        // the response never arrives; only the client's abort ends it.
        committedAt = Date.now();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }
      return Promise.resolve(
        Date.now() - committedAt <= GRACE_MS
          ? response({ accessToken: "tok_b", expiresIn: 900 }) // idempotent duplicate
          : response({ code: "REFRESH_REPLAYED" }, 401),
      );
    };
    return { refresh, presentedAt, committedAt: () => committedAt };
  }

  it("re-presents a timed-out, committed refresh inside the backend grace window", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.999); // worst-case jitter
    const backend = graceBackend();
    routeFetch({ me: () => Promise.resolve(response(userA)), refresh: backend.refresh });
    const store = createAuthStore({ baseUrl: "http://localhost:4000", refreshBuffer: 60 });
    await readySession(store);

    await vi.advanceTimersByTimeAsync(840_000); // scheduled renewal: hangs
    await vi.advanceTimersByTimeAsync(4_000); // client deadline aborts it
    expect(store.getSessionState().status).toBe("unavailable");
    await vi.advanceTimersByTimeAsync(2_000); // quick post-timeout retry

    expect(backend.presentedAt).toHaveLength(2);
    expect(backend.presentedAt[1]! - backend.committedAt()!).toBeLessThanOrEqual(10_000);
    expect(store.getSessionState()).toMatchObject({ status: "ready", token: "tok_b" });
  });

  it("does not defer the post-timeout retry in a hidden tab (it would leave the grace)", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "hidden" }));
    const backend = graceBackend();
    routeFetch({ me: () => Promise.resolve(response(userA)), refresh: backend.refresh });
    const store = createAuthStore({ baseUrl: "http://localhost:4000", refreshBuffer: 60 });
    await readySession(store);

    await vi.advanceTimersByTimeAsync(840_000 + 4_000 + 2_000);

    expect(backend.presentedAt).toHaveLength(2);
    expect(store.getSessionState()).toMatchObject({ status: "ready", token: "tok_b" });
  });

  // Review P3 probes.
  it("a manual refresh and revalidate during the backoff never leave more than one timer", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { store } = await failedRenewal();
    await store.resolveSession({ refresh: true });
    await store.revalidateSession();
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
  });

  it("a new login resets the backoff", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    let online = false;
    const { store, refreshes } = await failedRenewal({ online: () => online });
    await vi.advanceTimersByTimeAsync(5_000); // second failure → next step 15s
    expect(refreshes()).toBe(2);

    online = true;
    store.setAccessToken("tok_new", 900);
    await vi.advanceTimersByTimeAsync(20_000);
    // No stale backoff retry fires after the new credential was adopted.
    expect(refreshes()).toBe(2);
  });

  // CEL-2107 residual P2 — after a lost response the tab may keep presenting
  // the old cookie only inside a commit window that stays within the 10s
  // grace; after that it fails closed LOCALLY (session-uncertain) instead of
  // risking REFRESH_REPLAYED, which revokes the family on every device.
  function uncertainBackend(after: "hang" | "offline") {
    const GRACE_MS = 10_000;
    let committedAt: number | null = null;
    const presentedAt: number[] = [];
    let replayed = 0;
    const refresh: Route = (init) => {
      presentedAt.push(Date.now());
      if (committedAt !== null && Date.now() - committedAt > GRACE_MS) {
        replayed += 1;
        return Promise.resolve(response({ code: "REFRESH_REPLAYED" }, 401));
      }
      if (committedAt === null) committedAt = Date.now(); // commits; response lost
      else if (after === "offline") return Promise.reject(new TypeError("Failed to fetch"));
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    };
    return { refresh, presentedAt, committedAt: () => committedAt!, replayed: () => replayed };
  }

  it.each(["hang", "offline"] as const)(
    "lost response, then %s: retries only inside the commit window, then fails closed as session-uncertain",
    async (after) => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0.999); // worst-case jitter
      const backend = uncertainBackend(after);
      routeFetch({ me: () => Promise.resolve(response(userA)), refresh: backend.refresh });
      const store = createAuthStore({ baseUrl: "http://localhost:4000", refreshBuffer: 60 });
      await readySession(store);
      const states: SessionState[] = [];
      store.onSessionStateChange((state) => states.push(state));

      await vi.advanceTimersByTimeAsync(840_000); // scheduled renewal: commits, hangs
      await vi.advanceTimersByTimeAsync(120_000); // quick retries, then the window closes

      expect(backend.replayed()).toBe(0);
      expect(backend.presentedAt.length).toBeGreaterThanOrEqual(2); // it did retry
      for (const at of backend.presentedAt) {
        expect(at - backend.committedAt()).toBeLessThan(8_000); // inside the window
      }
      expect(states.at(-1)).toEqual({ status: "unauthorized", reason: "session-uncertain" });
      expect(store.getAccessToken()).toBeNull();

      // Nothing may present the cookie again: not a cold resolve, not "Try
      // again" (revalidate), not more time passing.
      const presented = backend.presentedAt.length;
      await expect(store.resolveSession()).resolves.toEqual({ status: "unauthorized" });
      await store.revalidateSession();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(backend.presentedAt).toHaveLength(presented);
      expect(backend.replayed()).toBe(0);
    },
  );

  it("a new sign-in ends the uncertainty", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const backend = uncertainBackend("offline");
    const calls = routeFetch({ me: () => Promise.resolve(response(userA)), refresh: backend.refresh });
    const store = createAuthStore({ baseUrl: "http://localhost:4000", refreshBuffer: 60 });
    await readySession(store);
    await vi.advanceTimersByTimeAsync(840_000 + 120_000);
    expect(store.getSessionState()).toEqual({ status: "unauthorized", reason: "session-uncertain" });

    // OTP sign-in adopts a brand-new credential (new refresh cookie).
    store.setAccessToken("tok_new", 900);
    await store.resolveSession({ refresh: false });
    expect(store.getSessionState()).toMatchObject({ status: "ready", token: "tok_new" });
    const before = calls.filter((c) => c === "/auth/refresh").length;
    await vi.advanceTimersByTimeAsync(840_000); // its own scheduled renewal presents again
    expect(calls.filter((c) => c === "/auth/refresh").length).toBe(before + 1);
  });

  // CEL-2107 — the uncertainty survives a reload and is SHARED by same-origin
  // tabs (localStorage, timestamps only): tabs share one refresh cookie jar.
  function memoryStorage() {
    const map = new Map<string, string>();
    return {
      map,
      storage: {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
        clear: () => map.clear(),
        key: () => null,
        get length() {
          return map.size;
        },
      } as Storage,
    };
  }

  /**
   * A backend with a real shared cookie JAR (what same-origin tabs share) and
   * a real 10s grace. The first presentation rotates server-side but its
   * response is lost (the jar keeps the old cookie); a duplicate of the old
   * cookie inside the grace returns the committed successor; the old cookie
   * outside it is REFRESH_REPLAYED. `afterLoss` decides what later
   * presentations do until `online` is set.
   */
  function jarBackend(afterLoss: "hang" | "offline") {
    const GRACE_MS = 10_000;
    let serial = 0;
    let current = "c0";
    let previous: string | null = null;
    let rotatedAt = 0;
    let jar = "c0";
    let lost = false;
    let online = false;
    const presentedAt: number[] = [];
    let replayed = 0;
    const hang = (init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const refresh: Route = (init) => {
      presentedAt.push(Date.now());
      if (!lost) {
        lost = true;
        previous = current;
        current = `c${++serial}`;
        rotatedAt = Date.now();
        return hang(init); // committed, response lost: jar keeps the old cookie
      }
      if (!online) return afterLoss === "offline" ? Promise.reject(new TypeError("Failed to fetch")) : hang(init);
      if (jar === previous) {
        if (Date.now() - rotatedAt > GRACE_MS) {
          replayed += 1;
          return Promise.resolve(response({ code: "REFRESH_REPLAYED" }, 401));
        }
        jar = current; // idempotent duplicate: the committed successor
      } else if (jar === current) {
        previous = current;
        current = `c${++serial}`;
        rotatedAt = Date.now();
        jar = current;
      }
      return Promise.resolve(response({ accessToken: `tok_${jar}`, expiresIn: 900 }));
    };
    return {
      refresh,
      presentedAt,
      committedAt: () => rotatedAt,
      replayed: () => replayed,
      goOnline: () => {
        online = true;
      },
    };
  }

  const API = "http://localhost:4000";

  it("a reload inside the window does not bypass it: the cold resolve refuses once it has passed", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { map, storage } = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const backend = uncertainBackend("offline");
    routeFetch({ me: () => Promise.resolve(response(userA)), refresh: backend.refresh });
    const first = createAuthStore({ baseUrl: API, refreshBuffer: 60 });
    await readySession(first);

    await vi.advanceTimersByTimeAsync(840_000); // commits, response lost
    await vi.advanceTimersByTimeAsync(4_000); // timed out: uncertainty recorded
    // Timestamps and the refresh attempt id are persisted, never a token.
    for (const [key, value] of map) {
      if (key.endsWith(":refresh-attempt-id")) {
        expect(value).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
        continue;
      }
      expect(value).toMatch(/^\d+$/);
      expect(key).not.toMatch(/token/i);
    }

    await vi.advanceTimersByTimeAsync(6_000); // the user reloads after the window
    const presented = backend.presentedAt.length;
    const reloaded = createAuthStore({ baseUrl: API, refreshBuffer: 60 });
    const states: SessionState[] = [];
    reloaded.onSessionStateChange((state) => states.push(state));

    await expect(reloaded.resolveSession()).resolves.toEqual({ status: "unauthorized" });
    expect(backend.presentedAt).toHaveLength(presented); // no late presentation
    expect(backend.replayed()).toBe(0);
    expect(states.at(-1)).toEqual({ status: "unauthorized", reason: "session-uncertain" });
  });

  it("a confirmed rotation ends the uncertainty (a later refresh presents again)", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.stubGlobal("localStorage", memoryStorage().storage);
    const backend = jarBackend("hang");
    const calls = routeFetch({ me: () => Promise.resolve(response(userA)), refresh: backend.refresh });
    const store = createAuthStore({ baseUrl: API, refreshBuffer: 60 });
    await readySession(store);
    await vi.advanceTimersByTimeAsync(840_000 + 4_000); // lost + timed out
    backend.goOnline();
    await vi.advanceTimersByTimeAsync(2_000); // quick retry confirms the rotation
    expect(store.getSessionState()).toMatchObject({ status: "ready", token: "tok_c1" });

    await vi.advanceTimersByTimeAsync(30_000); // far past the old window
    const before = calls.filter((c) => c === "/auth/refresh").length;
    await store.resolveSession({ refresh: true });
    expect(calls.filter((c) => c === "/auth/refresh").length).toBe(before + 1);
    expect(backend.replayed()).toBe(0);
  });

  it("falls back to memory when localStorage throws", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    });
    const backend = uncertainBackend("offline");
    routeFetch({ me: () => Promise.resolve(response(userA)), refresh: backend.refresh });
    const store = createAuthStore({ baseUrl: API, refreshBuffer: 60 });
    await readySession(store);
    await vi.advanceTimersByTimeAsync(840_000 + 120_000);
    expect(store.getSessionState()).toEqual({ status: "unauthorized", reason: "session-uncertain" });
    expect(backend.replayed()).toBe(0);
  });

  // 0.20.1 residual B — tab B has its OWN store but shares the cookie jar and
  // localStorage with tab A.
  it("tab B presents only inside tab A's commit window and never after it", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.stubGlobal("localStorage", memoryStorage().storage);
    const backend = jarBackend("offline");
    routeFetch({ me: () => Promise.resolve(response(userA)), refresh: backend.refresh });
    const tabA = createAuthStore({ baseUrl: API, refreshBuffer: 60 });
    await readySession(tabA);
    // Tab B was already open and signed in (it did NOT adopt a new credential
    // after A's loss; a new sign-in would legitimately end the uncertainty).
    // Its own renewal timer is pushed out so only the explicit calls below act.
    const tabB = createAuthStore({ baseUrl: `${API}/`, refreshBuffer: -3_600 }); // same origin
    await readySession(tabB);
    await vi.advanceTimersByTimeAsync(840_000 + 4_000); // A: lost + timed out

    const statesB: SessionState[] = [];
    tabB.onSessionStateChange((state) => statesB.push(state));
    await tabB.resolveSession({ refresh: true }); // inside the window: allowed
    await vi.advanceTimersByTimeAsync(120_000); // both tabs run out the window

    for (const at of backend.presentedAt) expect(at - backend.committedAt()).toBeLessThan(8_000);
    const presented = backend.presentedAt.length;
    await tabB.resolveSession({ refresh: true }); // after the window: refused
    await tabB.revalidateSession();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(backend.presentedAt).toHaveLength(presented);
    expect(backend.replayed()).toBe(0);
    expect(statesB.at(-1)).toEqual({ status: "unauthorized", reason: "session-uncertain" });
  });

  it("tab A's confirmed rotation clears the uncertainty for tab B (no extra sign-in)", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.stubGlobal("localStorage", memoryStorage().storage);
    const backend = jarBackend("hang");
    routeFetch({ me: () => Promise.resolve(response(userA)), refresh: backend.refresh });
    const tabA = createAuthStore({ baseUrl: API, refreshBuffer: 60 });
    await readySession(tabA);
    await vi.advanceTimersByTimeAsync(840_000 + 4_000); // A: lost + timed out
    backend.goOnline();
    await vi.advanceTimersByTimeAsync(2_000); // A's quick retry confirms (jar is live)
    expect(tabA.getSessionState()).toMatchObject({ status: "ready" });

    await vi.advanceTimersByTimeAsync(60_000); // long past A's window
    const tabB = createAuthStore({ baseUrl: API, refreshBuffer: 60 });
    await expect(tabB.resolveSession()).resolves.toMatchObject({ status: "ready" }); // cold, presents the live jar cookie
    expect(backend.replayed()).toBe(0);
  });

  // 0.20.1 P1 (also in 0.20.0): every app calls clearAccessToken() right
  // after the session-uncertain bounce; that LOCAL clear must not end the
  // uncertainty, or the sign-in page's cold refresh replays the old cookie.
  async function failedClosed(storage: Storage) {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.stubGlobal("localStorage", storage);
    const backend = uncertainBackend("offline");
    routeFetch({
      me: () => Promise.resolve(response(userA)),
      refresh: backend.refresh,
    });
    const tab = createAuthStore({ baseUrl: API, refreshBuffer: 60 });
    await readySession(tab);
    await vi.advanceTimersByTimeAsync(840_000 + 120_000);
    expect(tab.getSessionState()).toEqual({ status: "unauthorized", reason: "session-uncertain" });
    return { tab, backend };
  }

  it("a local clearAccessToken() after failing closed does not end the uncertainty", async () => {
    const { tab, backend } = await failedClosed(memoryStorage().storage);
    tab.clearAccessToken(); // what every app's unauthorized route does
    const presented = backend.presentedAt.length;

    await vi.advanceTimersByTimeAsync(300_000); // minutes later, on the sign-in page
    await tab.resolveSession({ refresh: true }); // the cold refresh
    await createAuthStore({ baseUrl: API, refreshBuffer: 60 }).resolveSession({ refresh: true }); // a reload

    expect(backend.presentedAt).toHaveLength(presented); // presented NOTHING
    expect(backend.replayed()).toBe(0);
  });

  it("a second tab's local clear does not end the uncertainty either", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.stubGlobal("localStorage", memoryStorage().storage);
    const backend = uncertainBackend("offline");
    routeFetch({ me: () => Promise.resolve(response(userA)), refresh: backend.refresh });
    const tabA = createAuthStore({ baseUrl: API, refreshBuffer: 60 });
    await readySession(tabA);
    // Tab B was already signed in before A's loss (its own timer pushed out).
    const tabB = createAuthStore({ baseUrl: API, refreshBuffer: -3_600 });
    await readySession(tabB);
    await vi.advanceTimersByTimeAsync(840_000 + 120_000); // A: lost, fails closed
    expect(tabA.getSessionState()).toEqual({ status: "unauthorized", reason: "session-uncertain" });

    tabB.clearAccessToken(); // tab B signs out locally
    const presented = backend.presentedAt.length;
    await vi.advanceTimersByTimeAsync(300_000);
    await tabA.resolveSession({ refresh: true });
    await tabB.resolveSession({ refresh: true });
    await createAuthStore({ baseUrl: API, refreshBuffer: 60 }).resolveSession({ refresh: true });
    expect(backend.presentedAt).toHaveLength(presented);
    expect(backend.replayed()).toBe(0);
  });

  it("a server-confirmed logout ends the uncertainty", async () => {
    const { storage } = memoryStorage();
    const { tab } = await failedClosed(storage);
    const client = createAuthClient({ baseUrl: API, store: tab });
    const api = createAuthApi({ client, store: tab });
    const fetchBefore = vi.mocked(global.fetch).getMockImplementation()!;
    vi.mocked(global.fetch).mockImplementation((url, init) =>
      String(url).endsWith("/auth/logout")
        ? Promise.resolve(response(null, 204))
        : fetchBefore(url, init),
    );
    await api.logout();
    expect(storage.getItem(`cellarnode:auth:default:${API}:possibly-committed-at`)).toBeNull();
  });

  it("a committed time in the future (clock set back) counts as expired: fails closed", async () => {
    vi.useFakeTimers();
    const { storage } = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    storage.setItem(`cellarnode:auth:default:${API}:possibly-committed-at`, String(Date.now() + 60_000));
    const backend = uncertainBackend("offline");
    routeFetch({ me: () => Promise.resolve(response(userA)), refresh: backend.refresh });
    const tab = createAuthStore({ baseUrl: API, refreshBuffer: 60 });
    const states: SessionState[] = [];
    tab.onSessionStateChange((state) => states.push(state));

    await tab.resolveSession({ refresh: true });
    expect(backend.presentedAt).toHaveLength(0);
    expect(states.at(-1)).toEqual({ status: "unauthorized", reason: "session-uncertain" });
  });

  it("a confirmed rotation removes the possibly-committed key", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { storage } = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const backend = jarBackend("hang");
    routeFetch({ me: () => Promise.resolve(response(userA)), refresh: backend.refresh });
    const tab = createAuthStore({ baseUrl: API, refreshBuffer: 60 });
    await readySession(tab);
    await vi.advanceTimersByTimeAsync(840_000 + 4_000);
    expect(storage.getItem(`cellarnode:auth:default:${API}:possibly-committed-at`)).not.toBeNull();
    backend.goOnline();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(tab.getSessionState()).toMatchObject({ status: "ready" });
    expect(storage.getItem(`cellarnode:auth:default:${API}:possibly-committed-at`)).toBeNull();
  });

  // Review P2 — a future-dated uncertainty must not trap the user after an
  // explicit sign-in (no later send could ever be ">= committed").
  it("a sign-in supersedes a future-dated uncertainty: a forced refresh presents and stays ready", async () => {
    vi.useFakeTimers();
    const { storage } = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    storage.setItem(`cellarnode:auth:default:${API}:possibly-committed-at`, String(Date.now() + 60_000));
    const calls = routeFetch({
      me: () => Promise.resolve(response(userA)),
      refresh: () => Promise.resolve(response({ accessToken: "tok_b", expiresIn: 900 })),
    });
    const tab = createAuthStore({ baseUrl: API, refreshBuffer: 60 });

    tab.setAccessToken("tok_a", 900); // explicit sign-in
    await tab.resolveSession({ refresh: false });
    const result = await tab.resolveSession({ refresh: true });

    expect(calls).toContain("/auth/refresh");
    expect(result).toMatchObject({ status: "ready", token: "tok_b" });
    expect(tab.getSessionState()).toMatchObject({ status: "ready" });
    expect(storage.getItem(`cellarnode:auth:default:${API}:possibly-committed-at`)).toBeNull();
  });
});
