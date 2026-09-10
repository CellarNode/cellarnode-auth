import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAuthStore } from "../src/auth-store.js";
import { createAuthClient } from "../src/auth-client.js";
import { createAuthApi } from "../src/auth-api.js";
import type { AuthUser } from "../src/types.js";

/**
 * CEL-1722 — client half of session families.
 *
 * Producer and e-label dashboards run independent `@cellarnode/auth` stores
 * against the same public API on the same browser origin. Backend PR
 * cellarnode-backend-v2#709 partitions refresh chains by a client-declared
 * family:
 *
 *   - `productFamily` in the `/auth/verify-otp` (+ `/auth/registration/session`)
 *     body at login → family-stamped session + family-scoped refresh cookie
 *     (`cn_rt_producer` / `cn_rt_elabel`).
 *   - `X-CellarNode-Family` header on `POST /auth/refresh` → server reads the
 *     family-scoped cookie (legacy `refresh_token` name stays the read
 *     fallback), and grants the bounded lost-response grace window.
 *   - Family-less clients (importer, admin, pre-upgrade) keep the exact legacy
 *     wire shape: no header, no body field.
 *
 * These tests drive the real store/client/api with an intercepted transport
 * and a shared cookie jar to prove the two families cannot clobber each other.
 */

const baseMe: AuthUser = {
  id: "user_123",
  email: "alice@example.com",
  name: "Alice",
  userType: "producer",
  orgId: "org_1",
  roles: ["member"],
  entitlements: ["producer-dashboard", "elabel"],
  createdAt: "2024-01-01T00:00:00.000Z",
};

interface CapturedRequest {
  path: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  };
}

/**
 * Emulated shared browser cookie jar + refresh-token backend.
 *
 * The jar is keyed by cookie NAME, exactly like a browser cookie store, so
 * `cn_rt_producer` and `cn_rt_elabel` (and the legacy `refresh_token`) are
 * independent slots. The refresh handler plays the CEL-1722 server role:
 * it reads the family from `X-CellarNode-Family`, consumes the matching
 * cookie, and rotates it in place. A family-less request reads the legacy
 * cookie.
 */
function createFamilyBackend(
  opts: { me?: AuthUser | null } = {},
): ReturnType<typeof buildBackend> {
  return buildBackend({ me: "me" in opts ? opts.me : baseMe });
}

function buildBackend(opts: { me?: AuthUser | null }) {
  const jar = new Map<string, string>();
  const requests: CapturedRequest[] = [];

  const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const path = typeof url === "string" ? url : new URL(url.toString()).pathname;
    let headers: Headers;
    let body: unknown = null;
    if (init && typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    if (init?.headers instanceof Headers) {
      headers = init.headers;
    } else {
      headers = new Headers((init?.headers as Record<string, string>) ?? {});
    }
    requests.push({
      path,
      method: init?.method ?? "GET",
      headers,
      body,
    });

    if (path.endsWith("/auth/me")) {
      if (opts.me == null) {
        return Promise.resolve(jsonResponse({ error: "unauthorized" }, false, 401));
      }
      return Promise.resolve(jsonResponse(opts.me));
    }

    if (path.endsWith("/auth/refresh")) {
      const declared = headers.get("x-cellarnode-family");
      const cookieName =
        declared === "producer"
          ? "cn_rt_producer"
          : declared === "elabel"
            ? "cn_rt_elabel"
            : "refresh_token";
      const presented = jar.get(cookieName);
      if (!presented) {
        return Promise.resolve(
          jsonResponse({ error: "No refresh token" }, false, 401),
        );
      }
      const rotated = `rt_${cookieName}_${Math.random().toString(36).slice(2, 8)}`;
      jar.set(cookieName, rotated);
      return Promise.resolve(
        jsonResponse({ accessToken: `tok_${cookieName}`, expiresIn: 900 }),
      );
    }

    if (path.endsWith("/auth/verify-otp")) {
      const bodyObj = (body ?? {}) as Record<string, unknown>;
      const family = bodyObj.productFamily;
      const cookieName =
        family === "producer"
          ? "cn_rt_producer"
          : family === "elabel"
            ? "cn_rt_elabel"
            : "refresh_token";
      jar.set(cookieName, `rt_${cookieName}_mint`);
      return Promise.resolve(
        jsonResponse({
          accessToken: `tok_verify_${cookieName}`,
          expiresIn: 900,
          user: {
            id: baseMe.id,
            email: baseMe.email,
            name: baseMe.name,
            userType: baseMe.userType,
            orgId: baseMe.orgId,
            roles: baseMe.roles,
          },
        }),
      );
    }

    if (path.endsWith("/auth/logout")) {
      // CEL-1722 server: ordinary logout clears only the CURRENT family's
      // cookie (derived from the bearer session server-side, no header).
      return Promise.resolve(jsonResponse({ success: true }));
    }

    return Promise.resolve(jsonResponse({}, false, 404));
  });

  return { jar, requests, fetchMock };
}

function lastRequest(requests: CapturedRequest[], path: string): CapturedRequest {
  const found = [...requests].reverse().find((r) => r.path.endsWith(path));
  if (!found) throw new Error(`no captured request for ${path}`);
  return found;
}

describe("CEL-1722 session families", () => {
  beforeEach(() => {
    // per-test backend set up inside each test
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("family declaration on refresh (header)", () => {
    it("sends X-CellarNode-Family on POST /auth/refresh when configured", async () => {
      const backend = createFamilyBackend();
      global.fetch = backend.fetchMock as unknown as typeof fetch;
      const store = createAuthStore({
        baseUrl: "http://localhost:4000",
        productFamily: "producer",
      });
      store.setAccessToken("tok_seed", 900);
      // Let the explicit-adoption flight (identity read) settle first — a
      // refresh requested mid-adoption joins the adoption per resolveSession.
      await store.resolveSession();
      await store.resolveSession({ refresh: true });

      const refreshReq = lastRequest(backend.requests, "/auth/refresh");
      expect(refreshReq.headers.get("x-cellarnode-family")).toBe("producer");
    });

    it("sends the elabel family value for an elabel store", async () => {
      const backend = createFamilyBackend();
      global.fetch = backend.fetchMock as unknown as typeof fetch;
      const store = createAuthStore({
        baseUrl: "http://localhost:4000",
        productFamily: "elabel",
      });
      store.setAccessToken("tok_seed", 900);
      // Let the explicit-adoption flight (identity read) settle first — a
      // refresh requested mid-adoption joins the adoption per resolveSession.
      await store.resolveSession();
      await store.resolveSession({ refresh: true });

      const refreshReq = lastRequest(backend.requests, "/auth/refresh");
      expect(refreshReq.headers.get("x-cellarnode-family")).toBe("elabel");
    });

    it("backward compat: family-less store sends NO family header", async () => {
      const backend = createFamilyBackend();
      global.fetch = backend.fetchMock as unknown as typeof fetch;
      const store = createAuthStore({ baseUrl: "http://localhost:4000" });
      store.setAccessToken("tok_seed", 900);
      // Let the explicit-adoption flight (identity read) settle first — a
      // refresh requested mid-adoption joins the adoption per resolveSession.
      await store.resolveSession();
      await store.resolveSession({ refresh: true });

      const refreshReq = lastRequest(backend.requests, "/auth/refresh");
      expect(refreshReq.headers.get("x-cellarnode-family")).toBeNull();
    });
  });

  describe("family declaration at login (verify-otp body)", () => {
    it("includes productFamily in the verify-otp body when the store declares one", async () => {
      const backend = createFamilyBackend();
      global.fetch = backend.fetchMock as unknown as typeof fetch;
      const store = createAuthStore({
        baseUrl: "http://localhost:4000",
        productFamily: "elabel",
      });
      const client = createAuthClient({
        baseUrl: "http://localhost:4000",
        store,
      });
      const api = createAuthApi({ client, store });

      const result = await api.verifyOtp("alice@example.com", "123456");
      expect(result.accessToken).toBe("tok_verify_cn_rt_elabel");

      const verifyReq = lastRequest(backend.requests, "/auth/verify-otp");
      expect(verifyReq.body).toEqual({
        email: "alice@example.com",
        code: "123456",
        productFamily: "elabel",
      });
    });

    it("backward compat: family-less verify-otp body carries no productFamily key", async () => {
      const backend = createFamilyBackend();
      global.fetch = backend.fetchMock as unknown as typeof fetch;
      const store = createAuthStore({ baseUrl: "http://localhost:4000" });
      const client = createAuthClient({
        baseUrl: "http://localhost:4000",
        store,
      });
      const api = createAuthApi({ client, store });

      await api.verifyOtp("alice@example.com", "123456");

      const verifyReq = lastRequest(backend.requests, "/auth/verify-otp");
      expect(verifyReq.body).toEqual({
        email: "alice@example.com",
        code: "123456",
      });
      expect(
        (verifyReq.body as Record<string, unknown>).productFamily,
      ).toBeUndefined();
    });
  });

  describe("per-family refresh coordination (concurrent stores)", () => {
    it("producer and elabel stores refresh independent cookies without clobbering", async () => {
      const backend = createFamilyBackend();
      global.fetch = backend.fetchMock as unknown as typeof fetch;
      backend.jar.set("cn_rt_producer", "p1");
      backend.jar.set("cn_rt_elabel", "e1");
      backend.jar.set("refresh_token", "legacy1");

      const producerStore = createAuthStore({
        baseUrl: "http://localhost:4000",
        productFamily: "producer",
      });
      const elabelStore = createAuthStore({
        baseUrl: "http://localhost:4000",
        productFamily: "elabel",
      });
      producerStore.setAccessToken("tok_p", 900);
      elabelStore.setAccessToken("tok_e", 900);
      await producerStore.resolveSession();
      await elabelStore.resolveSession();

      // Interleaved refreshes — the exact simultaneous-bootstrap /
      // simultaneous-expiry shape CEL-1722 requires to coexist.
      const [producerResult, elabelResult] = await Promise.all([
        producerStore.resolveSession({ refresh: true }),
        elabelStore.resolveSession({ refresh: true }),
      ]);

      expect(producerResult.status).toBe("ready");
      expect(elabelResult.status).toBe("ready");

      const producerReq = backend.requests.find(
        (r) =>
          r.path.endsWith("/auth/refresh") &&
          r.headers.get("x-cellarnode-family") === "producer",
      );
      const elabelReq = backend.requests.find(
        (r) =>
          r.path.endsWith("/auth/refresh") &&
          r.headers.get("x-cellarnode-family") === "elabel",
      );
      expect(producerReq).toBeDefined();
      expect(elabelReq).toBeDefined();

      // Both family cookies survived rotation — neither refresh consumed the
      // other family's cookie.
      expect(backend.jar.has("cn_rt_producer")).toBe(true);
      expect(backend.jar.has("cn_rt_elabel")).toBe(true);
      expect(backend.jar.get("cn_rt_producer")).not.toBe("p1");
      expect(backend.jar.get("cn_rt_elabel")).not.toBe("e1");
      // Legacy cookie untouched by family-declared refreshes.
      expect(backend.jar.get("refresh_token")).toBe("legacy1");
    });

    it("legacy family-less store keeps working against the legacy cookie", async () => {
      const backend = createFamilyBackend();
      global.fetch = backend.fetchMock as unknown as typeof fetch;
      backend.jar.set("refresh_token", "legacy1");

      const legacyStore = createAuthStore({ baseUrl: "http://localhost:4000" });
      legacyStore.setAccessToken("tok_legacy", 900);
      await legacyStore.resolveSession();
      const result = await legacyStore.resolveSession({ refresh: true });

      expect(result.status).toBe("ready");
      expect(backend.jar.get("refresh_token")).not.toBe("legacy1");
    });
  });

  describe("logout semantics", () => {
    it("ordinary logout posts /auth/logout with the bearer and no family header", async () => {
      const backend = createFamilyBackend();
      global.fetch = backend.fetchMock as unknown as typeof fetch;
      const store = createAuthStore({
        baseUrl: "http://localhost:4000",
        productFamily: "producer",
      });
      store.setAccessToken("tok_p", 900);
      // let identity settle so client.fetch continuity capture works
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const client = createAuthClient({
        baseUrl: "http://localhost:4000",
        store,
      });
      const api = createAuthApi({ client, store });
      await api.logout();

      const logoutReq = lastRequest(backend.requests, "/auth/logout");
      expect(logoutReq.method).toBe("POST");
      // The server derives the family from the bearer session's own claim —
      // the client must not need (and must not send) a family header here.
      expect(logoutReq.headers.get("x-cellarnode-family")).toBeNull();
      expect(logoutReq.headers.get("authorization")).toBe("Bearer tok_p");
    });
  });

  describe("store surface", () => {
    it("exposes the configured family via getProductFamily()", () => {
      const producer = createAuthStore({
        baseUrl: "http://localhost:4000",
        productFamily: "producer",
      });
      const elabel = createAuthStore({
        baseUrl: "http://localhost:4000",
        productFamily: "elabel",
      });
      const legacy = createAuthStore({ baseUrl: "http://localhost:4000" });
      expect(producer.getProductFamily?.()).toBe("producer");
      expect(elabel.getProductFamily?.()).toBe("elabel");
      expect(legacy.getProductFamily?.()).toBeNull();
    });
  });
});
