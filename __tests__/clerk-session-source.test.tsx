import { afterEach, describe, expect, test, vi } from "vitest";
import { build } from "esbuild";
import { cleanup, render } from "@testing-library/react";
import { useClerk } from "@clerk/react";
import type { ClerkSessionSource } from "../src/clerk/source.js";
import { createClerkSessionSource } from "../src/clerk/source.js";
import { ReactClerkSessionBridge } from "../src/clerk/react-bridge.js";
import type { ExternalSessionSnapshot } from "../src/types.js";

vi.mock("@clerk/react", () => ({ useClerk: vi.fn() }));

type ClerkClient = ReturnType<typeof useClerk>;
type Listener = Parameters<ClerkClient["addListener"]>[0];
type Resources = Parameters<Listener>[0];

function jwt(exp = Math.floor((Date.now() + 60_000) / 1000)): string {
  return `header.${btoa(JSON.stringify({ exp }))}.signature`;
}

function resources(sessionId: string | null, userId = "user-a", orgId: string | null = "org-a", token = jwt()): Resources {
  if (!sessionId) return { client: {} as Resources["client"], session: null, user: null, organization: null };
  const user = { id: userId, getSessions: vi.fn(async () => []) };
  const session = {
    id: sessionId,
    status: "active",
    user,
    getToken: vi.fn(async () => token),
  };
  return {
    client: {} as Resources["client"],
    session,
    user,
    organization: orgId ? { id: orgId } : null,
  } as unknown as Resources;
}

function fakeClerk(initial: Resources) {
  let emission: Listener | null = null;
  const unsubscribe = vi.fn();
  const clerk = {
    loaded: true,
    status: "ready",
    addListener: vi.fn((listener: Listener) => {
      emission = listener;
      listener(initial);
      return unsubscribe;
    }),
    signOut: vi.fn(async () => undefined),
  } as unknown as ClerkClient;
  return { clerk, emit: (next: Resources) => emission?.(next), unsubscribe };
}

function attach(source: ClerkSessionSource, state: Resources) {
  const provider = fakeClerk(state);
  const detach = source.attach(provider.clerk);
  return { ...provider, detach };
}

afterEach(() => cleanup());

describe("Clerk external session source", () => {
  test("starts loading; only ready active matching user and session become ready", () => {
    const source = createClerkSessionSource();
    expect(source.getSnapshot()).toEqual({ revision: 0, status: "loading" });
    const provider = attach(source, resources(null));
    expect(source.getSnapshot().status).toBe("signed-out");
    const loadingResources = { client: {} as Resources["client"], session: undefined, user: undefined, organization: undefined } as unknown as Resources;
    provider.emit(loadingResources);
    expect(source.getSnapshot().status).toBe("loading");
    const pending = resources("pending");
    (pending.session as unknown as { status: string }).status = "pending";
    provider.emit(pending);
    expect(source.getSnapshot().status).toBe("loading");
    provider.emit(resources("pending"));
    expect(source.getSnapshot().status).toBe("ready");
    provider.emit(resources("pending", "user-a", null));
    expect(source.getSnapshot().status).toBe("ready");
    const mismatched = resources("pending");
    (mismatched.session as unknown as { user: { id: string } }).user = { id: "user-b" };
    provider.emit(mismatched);
    expect(source.getSnapshot().status).toBe("loading");
    provider.detach();
    expect(source.getSnapshot().status).toBe("loading");
  });

  test("revisions track user, org, and session changes including ABA, not token renewal", () => {
    const source = createClerkSessionSource();
    const provider = attach(source, resources("s-a"));
    const readyRevision = source.getSnapshot().revision;
    provider.emit(resources("s-a", "user-a", "org-a", jwt(Math.floor((Date.now() + 120_000) / 1000))));
    expect(source.getSnapshot().revision).toBe(readyRevision);
    provider.emit(resources("s-b", "user-b", "org-b"));
    const nextRevision = source.getSnapshot().revision;
    provider.emit(resources("s-a", "user-a", "org-a"));
    expect(source.getSnapshot().revision).toBe(nextRevision + 1);
    const organizationRevision = source.getSnapshot().revision;
    provider.emit(resources("s-a", "user-a", null));
    expect(source.getSnapshot()).toEqual({ revision: organizationRevision + 1, status: "ready" });
    provider.emit(resources("s-a", "user-a", "org-a"));
    expect(source.getSnapshot()).toEqual({ revision: organizationRevision + 2, status: "ready" });
  });

  test("identity-only users receive credentials and organization changes fence stale tokens", async () => {
    const source = createClerkSessionSource();
    const token = jwt();
    const provider = attach(source, resources("s-a", "user-a", null, token));
    expect(source.getSnapshot().status).toBe("ready");
    await expect(source.getCredential({ skipCache: false, signal: new AbortController().signal }))
      .resolves.toMatchObject({ token, expiresAt: expect.any(Number) });

    let finish!: (token: string | null) => void;
    const identityOnly = resources("s-a", "user-a", null);
    vi.mocked(identityOnly.session!.getToken).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    provider.emit(identityOnly);
    const pendingCredential = source.getCredential({ skipCache: false, signal: new AbortController().signal });
    provider.emit(resources("s-a", "user-a", "org-a"));
    finish(jwt());
    await expect(pendingCredential).resolves.toBeNull();
    expect(source.getSnapshot().status).toBe("ready");
  });

  test("returns a bounded credential and rejects expiry, aborts, and late results", async () => {
    const source = createClerkSessionSource();
    const provider = attach(source, resources("s-a"));
    const signal = new AbortController().signal;
    await expect(source.getCredential({ skipCache: true, signal })).resolves.toMatchObject({ token: jwt(), expiresAt: expect.any(Number) });
    const expired = resources("s-a", "user-a", "org-a", jwt(1));
    provider.emit(expired);
    await expect(source.getCredential({ skipCache: false, signal })).resolves.toBeNull();
    const late = resources("s-a");
    const pending = vi.fn(() => new Promise<string | null>((resolve) => setTimeout(() => resolve(jwt()), 0)));
    (late.session as unknown as { getToken: typeof pending }).getToken = pending;
    provider.emit(late);
    const controller = new AbortController();
    const aborted = source.getCredential({ skipCache: false, signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    const stale = source.getCredential({ skipCache: false, signal });
    provider.emit(resources("s-b", "user-b", "org-b"));
    await expect(stale).resolves.toBeNull();
  });

  test("detach fences old callbacks and logout targets the captured session", async () => {
    const source = createClerkSessionSource();
    const provider = attach(source, resources("s-a"));
    const previousRevision = source.getSnapshot().revision;
    const logout = source.logout();
    provider.emit(resources("s-b", "user-b", "org-b"));
    await logout;
    expect(provider.clerk.signOut).toHaveBeenCalledWith({ sessionId: "s-a" });
    provider.detach();
    expect(provider.unsubscribe).toHaveBeenCalledOnce();
    const detached = source.getSnapshot();
    provider.emit(resources("s-c", "user-c", "org-c"));
    expect(source.getSnapshot()).toEqual(detached);
    expect(detached.revision).toBeGreaterThan(previousRevision);
  });

  test("listener reentrancy observes each synchronous provider revision and retains the newest resources", async () => {
    const source = createClerkSessionSource();
    const seen: ExternalSessionSnapshot[] = [];
    let provider: ReturnType<typeof fakeClerk> | null = null;
    let switched = false;
    const newer = resources("s-b", "user-b", "org-b", jwt(Math.floor((Date.now() + 180_000) / 1000)));
    source.subscribe(() => {
      const next = source.getSnapshot();
      seen.push(next);
      if (!switched && next.status === "ready") {
        switched = true;
        provider?.emit(newer);
      }
    });
    provider = attach(source, resources(null));
    provider.emit(resources("s-a"));
    expect(seen.slice(-2).map(({ revision }) => revision)).toEqual([
      source.getSnapshot().revision - 1,
      source.getSnapshot().revision,
    ]);
    expect(source.getSnapshot().status).toBe("ready");
    await source.getCredential({ skipCache: false, signal: new AbortController().signal });
    expect(newer.session?.getToken).toHaveBeenCalledOnce();
  });

  test("readiness ABA fences a pending credential even when identity IDs stay unchanged", async () => {
    const source = createClerkSessionSource();
    const state = resources("s-a");
    let finish!: (token: string) => void;
    vi.mocked(state.session!.getToken).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const provider = attach(source, state);
    const pendingCredential = source.getCredential({ skipCache: false, signal: new AbortController().signal });
    const pendingState = resources("s-a");
    (pendingState.session as unknown as { status: string }).status = "pending";
    provider.emit(pendingState);
    provider.emit(resources("s-a"));
    finish(jwt());
    await expect(pendingCredential).resolves.toBeNull();
  });

  test("readiness ABA stops a pending all-session revocation before writes", async () => {
    const source = createClerkSessionSource();
    const state = resources("s-a");
    let finish!: (sessions: unknown[]) => void;
    (state.user as unknown as { getSessions: () => Promise<unknown[]> }).getSessions = () =>
      new Promise((resolve) => { finish = resolve; });
    const provider = attach(source, state);
    const revocation = source.revokeAll!();
    const pendingState = resources("s-a");
    (pendingState.session as unknown as { status: string }).status = "pending";
    provider.emit(pendingState);
    provider.emit(resources("s-a"));
    const revoke = vi.fn();
    finish([{ id: "s-a", revoke }]);
    await expect(revocation).rejects.toThrow("Clerk user changed");
    expect(revoke).not.toHaveBeenCalled();
  });

  test("logout rejects when Clerk cannot end the captured session", async () => {
    const source = createClerkSessionSource();
    const provider = attach(source, resources("s-a"));
    vi.mocked(provider.clerk.signOut).mockRejectedValueOnce(new Error("sign out failed"));
    await expect(source.logout()).rejects.toThrow("sign out failed");
    expect(provider.clerk.signOut).toHaveBeenCalledWith({ sessionId: "s-a" });
    provider.detach();
  });

  test("revokes other user sessions first, then the captured current session", async () => {
    const source = createClerkSessionSource();
    const state = resources("s-current");
    const currentRevoke = vi.fn(async () => undefined);
    const otherRevoke = vi.fn(async () => undefined);
    (state.user as unknown as { getSessions: () => Promise<unknown[]> }).getSessions = async () => [
      { id: "s-current", revoke: currentRevoke }, { id: "s-other", revoke: otherRevoke },
    ];
    const provider = attach(source, state);
    await expect(source.revokeAll?.()).resolves.toEqual({ revokedSessions: 2 });
    expect(otherRevoke).toHaveBeenCalledOnce();
    expect(currentRevoke).toHaveBeenCalledOnce();
    expect(otherRevoke.mock.invocationCallOrder[0]).toBeLessThan(currentRevoke.mock.invocationCallOrder[0]);
    provider.detach();
  });

  test("fences a user switch while listing sessions and propagates partial revocation failure", async () => {
    const source = createClerkSessionSource();
    const state = resources("s-current");
    let finishListing: ((sessions: unknown[]) => void) | null = null;
    (state.user as unknown as { getSessions: () => Promise<unknown[]> }).getSessions = () =>
      new Promise((resolve) => { finishListing = resolve; });
    const provider = attach(source, state);
    const pending = source.revokeAll?.();
    provider.emit(resources("s-new", "user-new", "org-new"));
    finishListing?.([{ id: "s-current", revoke: vi.fn() }]);
    await expect(pending).rejects.toThrow("Clerk user changed");

    const fail = createClerkSessionSource();
    const failingState = resources("s-current");
    const otherRevoke = vi.fn(async () => undefined);
    const currentRevoke = vi.fn(async () => { throw new Error("revoke failed"); });
    (failingState.user as unknown as { getSessions: () => Promise<unknown[]> }).getSessions = async () => [
      { id: "s-current", revoke: currentRevoke }, { id: "s-other", revoke: otherRevoke },
    ];
    const failingProvider = attach(fail, failingState);
    await expect(fail.revokeAll?.()).rejects.toThrow("revoke failed");
    expect(otherRevoke).toHaveBeenCalledOnce();
    expect(currentRevoke).toHaveBeenCalledOnce();
    failingProvider.detach();
    provider.detach();
  });

  test("bridge renders no UI and owns listener cleanup", () => {
    const source = createClerkSessionSource();
    const provider = fakeClerk(resources(null));
    vi.mocked(useClerk).mockReturnValue(provider.clerk);
    const view = render(<ReactClerkSessionBridge source={source} />);
    expect(view.container.innerHTML).toBe("");
    expect(provider.clerk.addListener).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(source.getSnapshot().status).toBe("loading");
  });

  test("root entry bundle does not import the optional Clerk SDK", async () => {
    const result = await build({ entryPoints: ["src/index.ts"], bundle: true, platform: "browser", format: "esm", write: false });
    expect(result.outputFiles[0].text).not.toContain("@clerk/react");
  });
});
