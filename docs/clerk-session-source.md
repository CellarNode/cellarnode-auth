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
