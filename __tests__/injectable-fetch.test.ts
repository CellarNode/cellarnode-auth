import { describe, expect, test, vi } from "vitest";
import { createAuthClient } from "../src/auth-client.js";
import { createAuthStore } from "../src/auth-store.js";
import type { AuthStore } from "../src/types.js";

/**
 * CEL-2208 — hosts without a browser (the CellarNode MCP server) inject a
 * fetch implementation (cookie-jar-aware). Both the client transport and the
 * store's refresh/identity transport must route through it; nothing may call
 * the global fetch directly.
 */
function recordingFetch(): typeof fetch & { urls: string[] } {
  const urls: string[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch & { urls: string[] };
  (impl as unknown as { urls: string[] }).urls = urls;
  return impl;
}

const storeStub: AuthStore = {
  getAccessToken: () => "token-1",
  setAccessToken: () => {},
  clearAccessToken: () => {},
  getUserId: () => "u1",
  getOrgId: () => "o1",
  onAccessTokenSet: () => () => {},
};

describe("injectable fetchImpl", () => {
  test("createAuthClient routes requests through the injected fetch", async () => {
    const fetchImpl = recordingFetch();
    const client = createAuthClient({
      baseUrl: "http://localhost:4000",
      store: storeStub,
      fetchImpl,
    });
    const data = await client.fetch<{ ok: boolean }>("/auth/me");
    expect(data).toEqual({ ok: true });
    expect(fetchImpl.urls).toEqual(["http://localhost:4000/auth/me"]);
  });

  test("createAuthStore dev-login routes through the injected fetch", async () => {
    const fetchImpl = recordingFetch();
    const store = createAuthStore({
      baseUrl: "http://localhost:4000",
      fetchImpl,
    });
    await store.devLogin("qa@cellarnode.test");
    // The recording fetch returns { ok: true } — not a valid dev-login body,
    // so the result is a rejection; we assert the transport routing only.
    expect(fetchImpl.urls).toEqual(["http://localhost:4000/test/login"]);
  });
});
