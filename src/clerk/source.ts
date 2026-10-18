import type { useClerk } from "@clerk/react";
import type { ExternalSessionSnapshot, ExternalSessionSource } from "../types.js";

type ClerkClient = ReturnType<typeof useClerk>;
type ClerkListener = Parameters<ClerkClient["addListener"]>[0];
type ClerkResources = Parameters<ClerkListener>[0];

export interface ClerkSessionSource extends ExternalSessionSource {
  attach(clerk: ClerkClient): () => void;
}

function abortError(): Error {
  const error = new Error("Clerk credential request was aborted");
  error.name = "AbortError";
  return error;
}

function tokenExpiration(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const decoded = globalThis.atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const exp: unknown = JSON.parse(decoded).exp;
    const expiresAt = typeof exp === "number" ? exp * 1000 : Number.NaN;
    return Number.isFinite(expiresAt) && expiresAt > Date.now() ? expiresAt : null;
  } catch {
    return null;
  }
}

export function createClerkSessionSource(): ClerkSessionSource {
  let snapshot: ExternalSessionSnapshot = { revision: 0, status: "loading" };
  let identity = { userId: null as string | null, organizationId: null as string | null, sessionId: null as string | null };
  let clerk: ClerkClient | null = null;
  let resources: ClerkResources | null = null;
  let attachment = 0;
  let unsubscribeClerk: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const publish = (next: ExternalSessionSnapshot): void => {
    if (next.revision === snapshot.revision && next.status === snapshot.status) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };

  const detachCurrent = (): void => {
    attachment += 1;
    unsubscribeClerk?.();
    unsubscribeClerk = null;
    clerk = null;
    resources = null;
    identity = { userId: null, organizationId: null, sessionId: null };
    publish({ revision: snapshot.revision + 1, status: "loading" });
  };

  const isCurrent = (target: ClerkClient, targetAttachment: number, revision: number): boolean =>
    clerk === target && attachment === targetAttachment && snapshot.revision === revision && snapshot.status === "ready";

  const source: ClerkSessionSource = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    attach(nextClerk) {
      detachCurrent();
      clerk = nextClerk;
      const targetAttachment = attachment;
      const onResources: ClerkListener = (nextResources) => {
        if (clerk !== nextClerk || attachment !== targetAttachment) return;
        resources = nextResources;
        const nextIdentity = {
          userId: nextResources.user?.id ?? null,
          organizationId: nextResources.organization?.id ?? null,
          sessionId: nextResources.session?.id ?? null,
        };
        const changed = nextIdentity.userId !== identity.userId ||
          nextIdentity.organizationId !== identity.organizationId || nextIdentity.sessionId !== identity.sessionId;
        identity = nextIdentity;

        const session = nextResources.session;
        const user = nextResources.user;
        const organization = nextResources.organization;
        const signedOut = nextClerk.loaded && nextClerk.status === "ready" && session === null && user === null;
        const ready = nextClerk.loaded && nextClerk.status === "ready" &&
          session?.status === "active" && user != null && organization != null &&
          session.user?.id === user.id;
        const status = ready ? "ready" : signedOut ? "signed-out" : "loading";
        const readinessChanged = status !== snapshot.status;
        publish({ revision: snapshot.revision + (changed || readinessChanged ? 1 : 0), status });
      };
      const unsubscribe = nextClerk.addListener(onResources);
      if (clerk === nextClerk && attachment === targetAttachment) unsubscribeClerk = unsubscribe;
      else unsubscribe();
      return () => {
        if (clerk === nextClerk && attachment === targetAttachment) detachCurrent();
      };
    },
    async getCredential({ skipCache, signal }) {
      if (signal.aborted) throw abortError();
      const targetClerk = clerk;
      const targetResources = resources;
      const targetAttachment = attachment;
      const targetRevision = snapshot.revision;
      const session = targetResources?.session;
      if (snapshot.status !== "ready" || !targetClerk || !session || session.status !== "active") return null;

      const token = await session.getToken({ skipCache });
      if (signal.aborted) throw abortError();
      if (!isCurrent(targetClerk, targetAttachment, targetRevision)) return null;
      if (!token) return null;
      const expiresAt = tokenExpiration(token);
      return expiresAt === null ? null : { token, expiresAt };
    },
    async logout() {
      const targetClerk = clerk;
      const targetSessionId = resources?.session?.id;
      if (!targetClerk || !targetSessionId) return;
      await targetClerk.signOut({ sessionId: targetSessionId });
    },
    async revokeAll() {
      const targetClerk = clerk;
      const targetUser = resources?.user;
      const targetSessionId = resources?.session?.id;
      const targetAttachment = attachment;
      const targetRevision = snapshot.revision;
      if (!targetClerk || !targetUser || !targetSessionId || snapshot.status !== "ready") {
        throw new Error("Clerk is not ready to revoke sessions");
      }
      const sessions = await targetUser.getSessions();
      if (!isCurrent(targetClerk, targetAttachment, targetRevision)) throw new Error("Clerk user changed during session revocation");
      const current = sessions.find((session) => session.id === targetSessionId);
      if (!current) throw new Error("Clerk did not return the current session for revocation");
      const others = sessions.filter((session) => session.id !== targetSessionId);
      for (const session of others) {
        if (!isCurrent(targetClerk, targetAttachment, targetRevision)) throw new Error("Clerk user changed during session revocation");
        await session.revoke();
      }
      if (!isCurrent(targetClerk, targetAttachment, targetRevision)) throw new Error("Clerk user changed during session revocation");
      await current.revoke();
      return { revokedSessions: sessions.length };
    },
  };

  return source;
}
