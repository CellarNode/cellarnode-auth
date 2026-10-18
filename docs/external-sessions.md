# External sessions (CEL-2649)

Version 0.22.0 is an unpublished release candidate. No dependency, provider configuration, deployment, or consumer default changes are included. Omitting `sessionSource` retains the existing OTP and refresh-cookie behavior.

```ts
import { createAuthStore, type ExternalSessionSource } from "@cellarnode/auth";

const lifetime = new AbortController();
const source: ExternalSessionSource = providerBridge;
const store = createAuthStore({
  baseUrl: "https://api.cellarnode.com",
  sessionSource: source,
  lifecycleSignal: lifetime.signal,
});
await store.resolveSession();
// When the owning application unmounts:
lifetime.abort();
```

The source snapshot is `{ revision: number, status: "loading" | "signed-out" | "ready" }`. Its revision must increase monotonically for every provider user, organisation, or session transition, including A → B → A. `subscribe` must notify synchronously for revision and status changes. A `ready` snapshot means credentials can be acquired; it does not confer local authority.

`getCredential({ skipCache, signal })` returns `{ token, expiresAt }` or null. `expiresAt` is an absolute Unix timestamp in **milliseconds**. The bridge should honor cancellation and must return an accurate future expiry. The store also rejects late outcomes when a provider ignores cancellation. Forced renewal, authority revalidation, and 401 recovery request `skipCache: true`. Initial acquisition requests false. Expiry is used only for scheduling, never to derive identity or permissions. The refresh lead is capped at half the credential lifetime, so a 60-second credential renews after approximately 30 seconds.

The store validates every newly acquired credential through `/auth/me` before publishing `ready`. Local UUIDs, organisation, roles and entitlements come exclusively from that response. Provider grants and unverified token claims cannot grant access. Routine renewal requires the same local user and organisation; a changed provider revision clears the old baseline before acquiring the replacement session. Loading, null credentials, provider errors, timeouts and malformed backend responses are unavailable. Explicit provider sign-out or backend 401/403 is unauthorized.

External store identity reads and `createAuthClient` requests, including retries, use `credentials: "omit"`. External resolution does not call `/auth/refresh`, `/auth/revalidate`, or `/auth/refresh-probe`, and does not read or write legacy uncertainty storage. A private store binding makes `createAuthApi` select external lifecycle operations automatically.

## Lifecycle contract

`logout()` must capture its target provider session synchronously, before its first await. An SDK bridge must use that captured session ID for sign-out, never whichever session happens to be selected after an await. `revokeAll()` similarly captures its target user. The store invokes the callback first so it captures the target before reentrant observers can switch sessions, then clears local readiness in the same turn before awaiting completion. Completion never clears a replacement session. Failed logout/revocation keeps the old revision quarantined; it cannot reacquire until a new provider revision exists.

Omit `revokeAll` when unsupported. `signOutEverywhere` then throws `AuthError` with code `EXTERNAL_SESSION_UNSUPPORTED`, without transport or fake success. Unsupported registration, OTP requests/verification, unmanaged `getMe` credentials, and direct `setAccessToken` also throw that actionable error. `devLogin` retains its never-reject contract and returns a failure result.

A lifetime abort unsubscribes, invalidates pending work, clears readiness and prevents future acquisition. Consumers must provide and abort this signal for owned stores.

## Continuity and implementation boundary

Use the original object returned by `captureSessionContinuity` for replay checks. External captures have private store/revision provenance; cloning, reconstructing or moving them between stores fails closed. Ordinary renewal of the same local IDs within the same provider revision remains replayable. Provider ABA cannot make an old capture valid again, even with identical token text and local IDs. Legacy manually constructed captures retain their existing behavior.

Successful authenticated external responses are checked again after JSON body parsing, including 401 retries. A changed source revision, logout, disposal, or changed validated local user/organisation rejects the response as superseded. Same-source renewal retains valid responses across token changes and while the confirmed identity is revalidating. Public requests and legacy response behavior remain unchanged.

The pre-existing auth-store state machine remains cohesive: external acquisition shares its generation fencing, refresh flight, publication ordering, caller-only cancellation and identity validation. Its existing large-file size is an intentional exception; splitting or duplicating the full legacy concurrency engine would expand this migration's risk. The new private binding module is below 250 lines and introduces no React or provider SDK import into core.

MCP tool: deferred, CEL-2649 implements the client authentication boundary; sign-in and credential lifecycle are deliberate MCP capability exclusions. Existing authenticated tool permissions continue to come from backend `/auth/me` authority.
