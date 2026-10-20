# Clerk session source

`@cellarnode/auth/clerk` adapts Clerk React 6.17.8 to the external session
source accepted by `createAuthStore`. The Clerk user, organisation and session
IDs are used only to detect provider-session changes. The local identity and
permissions always come from the store's validated `/auth/me` response.

The adapter starts in `loading`. It becomes `signed-out` only after a ready
Clerk client reports no active user or session. It becomes `ready` when Clerk
reports a ready client, an active session, and a matching user. An active user
without an organisation is still authenticated and can resolve through the
local identity mapping; the store's `/auth/me` response remains the source of
local identity and permissions. Without an organisation, no organisation roles
or features are implied. Missing or pending resources, or a session whose user
does not match the active user, remain `loading`.

Changes between no organisation and a selected organisation advance the
provider revision. Credentials fetched for the previous state are discarded,
so workspace-specific authorization must be resolved again from `/auth/me`.

Create the source and store before mounting React, then mount the lifecycle
bridge under the app's `ClerkProvider`:

```ts
import { createAuthStore } from "@cellarnode/auth";
import { createClerkSessionSource } from "@cellarnode/auth/clerk";

export const clerkSessionSource = createClerkSessionSource();
export const authStore = createAuthStore({
  baseUrl: "https://api.example.com",
  sessionSource: clerkSessionSource,
});
```

```tsx
import { ReactClerkSessionBridge } from "@cellarnode/auth/clerk/react";
import { authStore, clerkSessionSource } from "./auth.js";

function App() {
  return (
    <ClerkProvider publishableKey={publishableKey}>
      <ReactClerkSessionBridge source={clerkSessionSource} />
      <Dashboard authStore={authStore} />
    </ClerkProvider>
  );
}
```

The bridge renders `null`; it only attaches and detaches the provider listener.
The adapter requests tokens from the captured Clerk session, honors aborts,
and accepts a credential only if its provider revision is still current. JWT
`exp` is read only to schedule renewal. It is not used to establish identity or
permissions. Tokens are held only for the active request and are not persisted.

`logout()` targets the captured Clerk session ID. `revokeAll()` enumerates all
active sessions for the captured Clerk user, revokes other sessions first, and
revokes the current session last. If Clerk does not return the captured current
session or a revocation fails, it rejects instead of reporting partial work as
success.

Clerk is an optional peer dependency, so existing root and `/react` imports do
not load the Clerk SDK. Install the exact supported version when using either
Clerk subpath:

```bash
npm install @clerk/react@6.17.8
```

## Released versions and adoption

The migration release is `@cellarnode/auth@0.23.1`, with the optional
`@clerk/react@6.17.8` peer. Release `0.22.0` introduced the external-session
store, `0.23.0` added the browser bridge, and `0.23.1` permits a valid identity
without a selected organisation. Use `0.23.1` for the coordinated customer
migration. The last published pre-Clerk library version is `0.21.0`.

Package publication does not activate Clerk. The producer, importer and e-label
applications choose their provider in their own configuration, and the backend
must accept that same credential family. Keep existing legacy configuration
until the coordinated cutover has passed its account-mapping and access checks.
The admin dashboard retains its GitHub OAuth BFF cookie flow; installing this
package does not move admin authentication to Clerk.

For each Vite consumer:

1. Pin the migration version and supported Clerk peer in its manifest and
   lockfile. Keep the existing legacy store construction available for rollback.
2. Construct the source/store once, and attach the bridge beneath
   `ClerkProvider` as shown above. Only the Clerk publishable key belongs in the
   browser; backend secret and webhook keys must never enter the client bundle.
3. Wait for store resolution before rendering protected workspace data. A
   signed-in user without an organisation is an authenticated identity, not an
   authorised workspace. Use the validated local identity and permissions.
4. Connect identity, organisation and sign-out transitions to the consumer's
   existing query-cache and realtime cleanup. The shared store fences stale
   credentials and responses, but it does not own a consumer's query cache.
   Cancel prior-context work and remove its cached data before exposing the new
   workspace. Test user and organisation switches as well as logout.
5. Keep redirect destinations inside the consumer's existing validated routing
   flow. The bridge renders no page and does not choose sign-in, invitation or
   post-login destinations. Use the native Clerk flow selected by the consumer;
   do not inject legacy OTP credentials into an external-session store.

The core entry and legacy React entry remain independent of the Clerk peer.
The Clerk React bridge is a browser integration for the existing Vite SPAs; it
does not establish an SSR or React Native support contract.

## Rollback boundary

Before activation, the additive package may remain installed while consumers
continue constructing legacy stores without a `sessionSource`. For a library
regression, restore the previously verified consumer release and lockfile.
`0.21.0` is the pre-Clerk package baseline, but an application importing
`@cellarnode/auth/clerk` cannot simply downgrade to it: restore the matching
legacy application code too.

After global activation, a package downgrade alone is not an authentication
rollback. Follow the coordinated customer cutover runbook in
[`CEL-2670`](https://linear.app/cellarnode/issue/CEL-2670): restore the verified
legacy backend and frontend configuration together, with the preserved domain
UUIDs, mappings and business data. Confirm sign-in and authorised workspace
access before restoring traffic. Existing Clerk sessions do not become legacy
sessions; users may need to sign in again. Do not delete provider identities,
mapping records or audit history as part of a package rollback.

The library release checks cover legacy/external-session contracts, stale
response fencing, typechecking, build and package exports. Consumer browser
acceptance and production cutover evidence remain separate requirements.
