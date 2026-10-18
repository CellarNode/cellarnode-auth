import { vi } from "vitest";
import { createAuthApi, createAuthClient, createAuthStore } from "../src/index.js";
import type { AuthUser, ExternalSessionCredential, ExternalSessionSnapshot, ExternalSessionSource } from "../src/index.js";

export const user: AuthUser = {
  id: "local-user", orgId: "local-org", email: "qa@example.test", name: "QA",
  userType: "producer", roles: ["member"], entitlements: ["producer-dashboard"], createdAt: "2026-10-18",
};

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function fixture() {
  let snapshot: ExternalSessionSnapshot = { revision: 1, status: "ready" };
  const listeners = new Set<() => void>();
  const source: ExternalSessionSource = {
    getSnapshot: vi.fn(() => ({ ...snapshot })),
    subscribe: vi.fn((listener) => { listeners.add(listener); return () => listeners.delete(listener); }),
    getCredential: vi.fn(async () => ({ token: "provider-token", expiresAt: Date.now() + 60_000 })),
    logout: vi.fn(async () => {}),
  };
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(user));
  const lifecycle = new AbortController();
  const store = createAuthStore({ baseUrl: "https://api.example.test", sessionSource: source, fetchImpl, lifecycleSignal: lifecycle.signal, resolutionTimeoutMs: 100 });
  const client = createAuthClient({ baseUrl: "https://api.example.test", store, fetchImpl });
  const api = createAuthApi({ store, client });
  return {
    source, store, client, api, fetchImpl, lifecycle, listeners,
    change(next: ExternalSessionSnapshot) {
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
}

export type Credential = ExternalSessionCredential | null;
export const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
