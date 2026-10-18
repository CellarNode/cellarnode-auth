import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { captureSessionContinuity } from "../src/index.js";
import { deferred, fixture, tick, user } from "./external-session-fixture.js";
import type { Credential } from "./external-session-fixture.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("external credential authority", () => {
  test("requires validated /me and never touches legacy storage or cookies", async () => {
    const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
    vi.stubGlobal("localStorage", storage);
    const f = fixture();
    const me = deferred<Response>();
    f.fetchImpl.mockReturnValueOnce(me.promise);
    const pending = f.store.resolveSession();
    await tick();
    expect(f.store.getSessionState().status).toBe("resolving");
    expect(f.store.getUserId()).toBeNull();
    me.resolve(Response.json(user));
    expect(await pending).toEqual({ status: "ready", token: "provider-token", user });
    expect(f.source.getCredential).toHaveBeenCalledWith({ skipCache: false, signal: expect.any(AbortSignal) });
    expect(f.fetchImpl).toHaveBeenCalledWith("https://api.example.test/auth/me", expect.objectContaining({ credentials: "omit" }));
    await f.store.revalidateSession();
    await f.store.resolveSession({ refresh: true });
    f.store.endSessionUncertainty();
    expect(f.fetchImpl.mock.calls.every(([url]) => String(url).endsWith("/auth/me"))).toBe(true);
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  test("renewal, revalidation and protected 401 recovery share one flight", async () => {
    const f = fixture();
    await f.store.resolveSession();
    const original = deferred<Response>();
    f.fetchImpl.mockReturnValueOnce(original.promise);
    const request = f.client.fetch("/protected");
    const credential = deferred<Credential>();
    vi.mocked(f.source.getCredential).mockReturnValueOnce(credential.promise);
    const renewed = f.store.resolveSession({ refresh: true });
    const revalidated = f.store.revalidateSession();
    original.resolve(Response.json({}, { status: 401 }));
    await tick();
    expect(f.source.getCredential).toHaveBeenCalledTimes(2);
    expect(f.store.getSessionState()).toMatchObject({ status: "revalidating", user });
    credential.resolve({ token: "renewed", expiresAt: Date.now() + 60_000 });
    expect((await renewed).status).toBe("ready");
    expect(await revalidated).toEqual(await renewed);
    expect(await request).toEqual(user);
    expect(f.fetchImpl.mock.calls.at(-1)?.[1]).toMatchObject({ credentials: "omit" });
    expect(captureSessionContinuity(f.store)).toEqual({ token: "renewed", userId: user.id, orgId: user.orgId });
  });

  test.each(["credential", "identity"])("ABA during %s rejects late promises even when token text repeats", async (phase) => {
    const f = fixture();
    const credential = deferred<Credential>();
    const identity = deferred<Response>();
    if (phase === "credential") vi.mocked(f.source.getCredential).mockReturnValueOnce(credential.promise);
    else f.fetchImpl.mockReturnValueOnce(identity.promise);
    const old = f.store.resolveSession();
    await tick();
    f.change({ revision: 2, status: "loading" });
    expect(f.store.getUserId()).toBeNull();
    expect(f.store.getSessionState().status).toBe("unavailable");
    f.fetchImpl.mockResolvedValue(Response.json({ ...user, id: "new-local-user", orgId: "new-local-org" }));
    f.change({ revision: 3, status: "ready" });
    const current = await f.store.resolveSession();
    credential.resolve({ token: "provider-token", expiresAt: Date.now() + 60_000 });
    identity.resolve(Response.json(user));
    expect((await old).status).toBe("superseded");
    expect(current).toMatchObject({ status: "ready", user: { id: "new-local-user" } });
    await tick();
    expect(f.store.getUserId()).toBe("new-local-user");
  });

  test.each(["user", "org", "session"])("%s revision changes synchronously clear readiness and baseline", async () => {
    const f = fixture();
    await f.store.resolveSession();
    const next = deferred<Credential>();
    vi.mocked(f.source.getCredential).mockReturnValueOnce(next.promise);
    f.change({ revision: 2, status: "ready" });
    expect(f.store.getUserId()).toBeNull();
    expect(captureSessionContinuity(f.store)).toBeNull();
    f.fetchImpl.mockResolvedValue(Response.json({ ...user, orgId: "new-org" }));
    next.resolve({ token: "provider-token", expiresAt: Date.now() + 60_000 });
    expect(await f.store.resolveSession()).toMatchObject({ status: "ready", user: { orgId: "new-org" } });
  });

  test("caller abort cancels only that wait", async () => {
    const f = fixture();
    const credential = deferred<Credential>();
    vi.mocked(f.source.getCredential).mockReturnValueOnce(credential.promise);
    const caller = new AbortController();
    const canceled = f.store.resolveSession({ signal: caller.signal });
    const other = f.store.resolveSession();
    caller.abort();
    expect(await canceled).toEqual({ status: "superseded" });
    expect(vi.mocked(f.source.getCredential).mock.calls[0][0].signal.aborted).toBe(false);
    credential.resolve({ token: "token", expiresAt: Date.now() + 60_000 });
    expect((await other).status).toBe("ready");
  });

  test.each(["credential", "identity"])("%s timeout cannot publish a late outcome", async (phase) => {
    const f = fixture();
    const credential = deferred<Credential>();
    const identity = deferred<Response>();
    if (phase === "credential") vi.mocked(f.source.getCredential).mockReturnValueOnce(credential.promise);
    else f.fetchImpl.mockReturnValueOnce(identity.promise);
    const pending = f.store.resolveSession();
    await tick();
    await vi.advanceTimersByTimeAsync(101);
    expect((await pending).status).toBe("unavailable");
    credential.resolve({ token: "late", expiresAt: Date.now() + 60_000 });
    identity.resolve(Response.json(user));
    await tick();
    expect(f.store.getSessionState().status).toBe("unavailable");
    expect(f.store.getUserId()).toBeNull();
  });

  test.each([null, { token: "", expiresAt: 1e15 }, { token: "x", expiresAt: NaN }, { token: "x", expiresAt: 0 }])("invalid credential %j stays unavailable", async (credential) => {
    const f = fixture();
    vi.mocked(f.source.getCredential).mockResolvedValue(credential);
    expect((await f.store.resolveSession()).status).toBe("unavailable");
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  test("provider acquisition errors and loading never become signed-out", async () => {
    const f = fixture();
    vi.mocked(f.source.getCredential).mockRejectedValue(new Error("provider offline"));
    expect((await f.store.resolveSession()).status).toBe("unavailable");
    f.change({ revision: 1, status: "loading" });
    expect((await f.store.resolveSession()).status).toBe("unavailable");
    expect(f.source.getCredential).toHaveBeenCalledTimes(1);
    f.change({ revision: 2, status: "signed-out" });
    expect((await f.store.resolveSession()).status).toBe("unauthorized");
  });

  test.each([200, 401, 403, 500])("backend status %s fails closed", async (status) => {
    const f = fixture();
    f.fetchImpl.mockResolvedValue(Response.json({}, { status }));
    expect((await f.store.resolveSession()).status).toBe(status === 401 || status === 403 ? "unauthorized" : "unavailable");
    expect(f.store.getUserId()).toBeNull();
  });

  test("60 second tokens renew after 30 seconds instead of looping immediately", async () => {
    const f = fixture();
    await f.store.resolveSession();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f.source.getCredential).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.source.getCredential).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.source.getCredential).mock.calls[1][0].skipCache).toBe(true);
    expect(f.store.getSessionState().status).toBe("ready");
  });

  test.each(["id", "orgId"])("same-source %s divergence never gains authority", async (field) => {
    const f = fixture();
    await f.store.resolveSession();
    f.fetchImpl.mockResolvedValue(Response.json({ ...user, [field]: "unexpected" }));
    expect((await f.store.revalidateSession()).status).toBe("unauthorized");
    expect(f.store.getUserId()).toBeNull();
  });

  test("reentrant ready listeners can switch session without publishing stale token events", async () => {
    const f = fixture();
    const tokens: Array<string | null> = [];
    f.store.onAccessTokenSet((token) => tokens.push(token));
    f.store.onSessionStateChange((state) => {
      if (state.status === "ready") f.change({ revision: 2, status: "signed-out" });
    });
    expect((await f.store.resolveSession()).status).toBe("superseded");
    expect(tokens).not.toContain("provider-token");
    expect(f.store.getSessionState().status).toBe("unauthorized");
  });
});
