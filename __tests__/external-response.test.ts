import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { deferred, fixture, tick, user } from "./external-session-fixture.js";
import type { Credential } from "./external-session-fixture.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

test.each(["user", "org", "aba", "logout", "disposal"])("late successful response after %s is superseded", async (transition) => {
  const f = fixture();
  await f.store.resolveSession();
  const response = deferred<Response>();
  f.fetchImpl.mockReturnValueOnce(response.promise);
  const request = f.client.fetch("/protected");
  const rejected = expect(request).rejects.toMatchObject({ code: "SESSION_SUPERSEDED" });
  if (transition === "logout") await f.api.logout();
  else if (transition === "disposal") f.lifecycle.abort();
  else {
    if (transition === "aba") f.change({ revision: 2, status: "loading" });
    f.fetchImpl.mockResolvedValue(Response.json({ ...user,
      ...(transition === "user" ? { id: "new-user" } : {}),
      ...(transition === "org" ? { orgId: "new-org" } : {}),
    }));
    f.change({ revision: 3, status: "ready" });
    await f.store.resolveSession();
  }
  response.resolve(Response.json({ privateData: "old-session" }));
  await rejected;
  expect(f.fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/protected"))).toHaveLength(1);
});

test("stable-source renewal preserves a successful response with unchanged local IDs", async () => {
  const f = fixture();
  await f.store.resolveSession();
  const response = deferred<Response>();
  f.fetchImpl.mockReturnValueOnce(response.promise);
  const request = f.client.fetch("/protected");
  vi.mocked(f.source.getCredential).mockResolvedValue({ token: "renewed", expiresAt: Date.now() + 60_000 });
  await f.store.revalidateSession();
  response.resolve(Response.json({ valid: true }));
  expect(await request).toEqual({ valid: true });
});

test("stable-source in-flight renewal retains confirmed authority for successful responses", async () => {
  const f = fixture();
  await f.store.resolveSession();
  const response = deferred<Response>();
  f.fetchImpl.mockReturnValueOnce(response.promise);
  const request = f.client.fetch("/protected");
  const credential = deferred<Credential>();
  vi.mocked(f.source.getCredential).mockReturnValueOnce(credential.promise);
  const renewal = f.store.revalidateSession();
  response.resolve(Response.json({ valid: true }));
  expect(await request).toEqual({ valid: true });
  credential.resolve({ token: "renewed", expiresAt: Date.now() + 60_000 });
  await renewal;
});

test("source change while a successful response body parses is rejected", async () => {
  const f = fixture();
  await f.store.resolveSession();
  const body = deferred<unknown>();
  const response = Response.json({});
  vi.spyOn(response, "json").mockReturnValueOnce(body.promise);
  f.fetchImpl.mockResolvedValueOnce(response);
  const request = f.client.fetch("/protected");
  const rejected = expect(request).rejects.toMatchObject({ code: "SESSION_SUPERSEDED" });
  await tick();
  f.change({ revision: 2, status: "signed-out" });
  body.resolve({ privateData: "old-session" });
  await rejected;
});

test("successful 401 retry is fenced against a later source change", async () => {
  const f = fixture();
  await f.store.resolveSession();
  const retry = deferred<Response>();
  f.fetchImpl.mockResolvedValueOnce(Response.json({}, { status: 401 }))
    .mockImplementationOnce(async () => Response.json(user))
    .mockReturnValueOnce(retry.promise);
  const request = f.client.fetch("/protected");
  const rejected = expect(request).rejects.toMatchObject({ code: "SESSION_SUPERSEDED" });
  await tick();
  await tick();
  f.change({ revision: 2, status: "signed-out" });
  retry.resolve(Response.json({ privateData: "old-session" }));
  await rejected;
});

test("public responses remain usable across source changes", async () => {
  const f = fixture();
  const response = deferred<Response>();
  f.fetchImpl.mockReturnValueOnce(response.promise);
  const request = f.client.fetch("/public", { skipAuth: true });
  f.change({ revision: 2, status: "signed-out" });
  response.resolve(Response.json({ public: true }));
  expect(await request).toEqual({ public: true });
});

test("a canceled caller receives AbortError when its late successful response is superseded", async () => {
  const f = fixture();
  await f.store.resolveSession();
  const response = deferred<Response>();
  f.fetchImpl.mockReturnValueOnce(response.promise);
  const signal = new AbortController();
  const request = f.client.fetch("/protected", { signal: signal.signal });
  const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });
  signal.abort();
  f.change({ revision: 2, status: "signed-out" });
  response.resolve(Response.json({ privateData: "old-session" }));
  await rejected;
});
