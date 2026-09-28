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
