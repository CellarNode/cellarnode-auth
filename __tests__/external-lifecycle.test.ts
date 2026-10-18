import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createAuthStore } from "../src/index.js";
import { deferred, fixture, tick, user } from "./external-session-fixture.js";
import type { Credential } from "./external-session-fixture.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("external lifecycle", () => {
  test("legacy login methods and direct injection are rejected without transport", async () => {
    const f = fixture();
    const expected = { code: "EXTERNAL_SESSION_UNSUPPORTED" };
    await expect(f.api.requestOtp("qa@example.test")).rejects.toMatchObject(expected);
    await expect(f.api.verifyOtp("qa@example.test", "123456")).rejects.toMatchObject(expected);
    await expect(f.api.register({ email: "qa@example.test", name: "QA", userType: "producer" })).rejects.toMatchObject(expected);
    expect(() => f.store.setAccessToken("legacy-jwe", 900)).toThrow("setAccessToken is unavailable");
    expect(await f.store.devLogin("qa@example.test")).toMatchObject({ ok: false, status: 400, message: expect.stringContaining("devLogin is unavailable") });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  test.each(["logout", "signOutEverywhere"] as const)("%s clears immediately and quarantines its revision after provider failure", async (method) => {
    const f = fixture();
    const pending = deferred<{ revokedSessions: number }>();
    f.source.revokeAll = vi.fn(() => pending.promise);
    vi.mocked(f.source.logout).mockImplementation(() => pending.promise.then(() => {}));
    await f.store.resolveSession();
    const outcome = f.api[method]();
    const rejected = expect(outcome).rejects.toThrow("provider unavailable");
    expect(f.store.getAccessToken()).toBeNull();
    expect(f.store.getSessionState().status).toBe("unauthorized");
    expect((await f.store.resolveSession()).status).toBe("unauthorized");
    pending.reject(new Error("provider unavailable"));
    await rejected;
    expect((await f.store.revalidateSession()).status).toBe("unauthorized");
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    f.change({ revision: 2, status: "ready" });
    expect((await f.store.resolveSession()).status).toBe("ready");
  });

  test.each(["logout", "signOutEverywhere"] as const)("%s late success never clears a newly selected source", async (method) => {
    const f = fixture();
    const pending = deferred<{ revokedSessions: number }>();
    f.source.revokeAll = vi.fn(() => pending.promise);
    vi.mocked(f.source.logout).mockImplementation(() => pending.promise.then(() => {}));
    await f.store.resolveSession();
    const outcome = f.api[method]();
    f.fetchImpl.mockResolvedValue(Response.json({ ...user, id: "next-user" }));
    f.change({ revision: 2, status: "ready" });
    await f.store.resolveSession();
    pending.resolve({ revokedSessions: 3 });
    expect(await outcome).toEqual(method === "logout" ? undefined : { revokedSessions: 3 });
    expect(f.store.getUserId()).toBe("next-user");
    expect(f.fetchImpl.mock.calls.every(([url]) => String(url).endsWith("/auth/me"))).toBe(true);
  });

  test("unsupported revoke-all returns an explicit error without clearing or legacy calls", async () => {
    const f = fixture();
    await f.store.resolveSession();
    await expect(f.api.signOutEverywhere()).rejects.toMatchObject({ code: "EXTERNAL_SESSION_UNSUPPORTED" });
    expect(f.store.getSessionState().status).toBe("ready");
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("synchronous logout throw still clears and quarantines local authority", async () => {
    const f = fixture();
    await f.store.resolveSession();
    vi.mocked(f.source.logout).mockImplementation(() => { throw new Error("sync fail"); });
    await expect(f.api.logout()).rejects.toThrow("sync fail");
    expect(f.store.getAccessToken()).toBeNull();
    expect((await f.store.resolveSession()).status).toBe("unauthorized");
  });

  test("logout callback synchronously switching source cannot clear its replacement", async () => {
    const f = fixture();
    await f.store.resolveSession();
    vi.mocked(f.source.logout).mockImplementation(async () => {
      f.fetchImpl.mockResolvedValue(Response.json({ ...user, id: "replacement" }));
      f.change({ revision: 2, status: "ready" });
    });
    await f.api.logout();
    expect((await f.store.resolveSession()).status).toBe("ready");
    expect(f.store.getUserId()).toBe("replacement");
  });

  test("provider captures logout target before reentrant clear listeners switch sources", async () => {
    const f = fixture();
    const captured: number[] = [];
    vi.mocked(f.source.logout).mockImplementation(async () => { captured.push(f.source.getSnapshot().revision); });
    await f.store.resolveSession();
    f.store.onSessionStateChange((state) => {
      if (state.status === "unauthorized") f.change({ revision: 2, status: "ready" });
    });
    await f.api.logout();
    expect(captured).toEqual([1]);
    expect((await f.store.resolveSession()).status).toBe("ready");
  });

  test.each(["credential", "identity"])("lifecycle disposal cancels %s work and unsubscribes", async (phase) => {
    const f = fixture();
    const credential = deferred<Credential>();
    const me = deferred<Response>();
    if (phase === "credential") vi.mocked(f.source.getCredential).mockReturnValueOnce(credential.promise);
    else f.fetchImpl.mockReturnValueOnce(me.promise);
    const result = f.store.resolveSession();
    await tick();
    f.lifecycle.abort();
    expect(f.listeners.size).toBe(0);
    expect((await result).status).toBe("superseded");
    credential.resolve({ token: "late", expiresAt: Date.now() + 60_000 });
    me.resolve(Response.json(user));
    await tick();
    expect(f.store.getAccessToken()).toBeNull();
    expect((await f.store.resolveSession()).status).toBe("superseded");
    await expect(f.api.logout()).rejects.toMatchObject({ code: "EXTERNAL_SESSION_UNSUPPORTED" });
    expect(f.source.logout).not.toHaveBeenCalled();
  });

  test("an already-aborted lifetime never subscribes or acquires credentials", async () => {
    const f = fixture();
    f.lifecycle.abort();
    const store = createAuthStore({ baseUrl: "https://api.example.test", sessionSource: f.source, lifecycleSignal: f.lifecycle.signal });
    expect((await store.resolveSession()).status).toBe("superseded");
    expect(f.listeners.size).toBe(0);
    expect(f.source.getCredential).not.toHaveBeenCalled();
  });
});
