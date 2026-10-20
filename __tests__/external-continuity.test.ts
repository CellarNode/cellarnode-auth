import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { canReplaySession, captureSessionContinuity, createAuthStore, resolveSessionForReplay } from "../src/index.js";
import { deferred, fixture, tick, user } from "./external-session-fixture.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

test("captured same-source local IDs permit ordinary renewal", async () => {
  const f = fixture();
  await f.store.resolveSession();
  const before = captureSessionContinuity(f.store)!;
  const after = await resolveSessionForReplay(f.store, before);
  expect(after.status).toBe("ready");
  expect(canReplaySession(before, after, f.store)).toBe(true);
});

test("an old request cannot replay after provider ABA with identical tokens and local IDs", async () => {
  const f = fixture();
  await f.store.resolveSession();
  const before = captureSessionContinuity(f.store)!;
  const response = deferred<Response>();
  f.fetchImpl.mockReturnValueOnce(response.promise);
  const request = f.client.fetch("/protected");
  const rejected = expect(request).rejects.toMatchObject({ code: "SESSION_SUPERSEDED" });
  f.change({ revision: 2, status: "loading" });
  f.change({ revision: 3, status: "ready" });
  const after = await f.store.resolveSession();
  expect(canReplaySession(before, after, f.store)).toBe(false);
  expect((await resolveSessionForReplay(f.store, before)).status).toBe("superseded");
  response.resolve(Response.json({}, { status: 401 }));
  await rejected;
  expect(f.fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/protected"))).toHaveLength(1);
});

test("cloned and manually constructed external continuity fail closed", async () => {
  const f = fixture();
  const after = await f.store.resolveSession();
  const before = captureSessionContinuity(f.store)!;
  for (const forged of [{ ...before }, { token: "provider-token", userId: user.id, orgId: user.orgId }]) {
    expect(canReplaySession(forged, after, f.store)).toBe(false);
    expect((await resolveSessionForReplay(f.store, forged)).status).toBe("superseded");
  }
  expect(f.source.getCredential).toHaveBeenCalledTimes(1);
});

test("external continuity cannot cross stores, including stores sharing a provider", async () => {
  const f = fixture();
  await f.store.resolveSession();
  const before = captureSessionContinuity(f.store)!;
  const other = createAuthStore({ baseUrl: "https://api.example.test", sessionSource: f.source, fetchImpl: f.fetchImpl, lifecycleSignal: f.lifecycle.signal });
  const after = await other.resolveSession();
  expect(canReplaySession(before, after, other)).toBe(false);
  expect((await resolveSessionForReplay(other, before)).status).toBe("superseded");
  f.lifecycle.abort();
});

test("getMe rejects unmanaged credentials and uses guarded external resolution", async () => {
  const f = fixture();
  await expect(f.api.getMe("legacy-jwe")).rejects.toMatchObject({ code: "EXTERNAL_SESSION_UNSUPPORTED" });
  expect(f.fetchImpl).not.toHaveBeenCalled();
  expect(await f.api.getMe()).toEqual(user);
  expect(await f.api.getMe("provider-token")).toEqual(user);
  expect(f.fetchImpl).toHaveBeenCalledTimes(1);
});

test("source transition during /me cannot restore protected continuity", async () => {
  const f = fixture();
  await f.store.resolveSession();
  const before = captureSessionContinuity(f.store)!;
  const me = deferred<Response>();
  f.fetchImpl.mockReturnValueOnce(me.promise);
  const after = resolveSessionForReplay(f.store, before);
  await tick();
  f.change({ revision: 2, status: "ready" });
  await f.store.resolveSession();
  me.resolve(Response.json(user));
  expect((await after).status).toBe("superseded");
});
