# @cellarnode/auth

Shared OTP-based authentication for CellarNode dashboards — token store, API client, React UI components.

## Install

```bash
npm install @cellarnode/auth
```

## Usage

### Core (framework-agnostic)

```ts
import {
  canReplaySession,
  captureSessionContinuity,
  createAuthApi,
  createAuthClient,
  createAuthStore,
  resolveSessionForReplay,
} from "@cellarnode/auth";

const authStore = createAuthStore({
  baseUrl: "http://localhost:4000",
});

const authClient = createAuthClient({
  baseUrl: "http://localhost:4000",
  store: authStore,
  onAuthFailure: () => window.location.assign("/login"),
});

const authApi = createAuthApi({ client: authClient, store: authStore });
```

All package-owned requests require HTTPS. HTTP works automatically only for
exact loopback hosts `localhost`, `127.0.0.1`, and `[::1]` during local
development. Invalid URLs, userinfo, other schemes, non-loopback HTTP, and
request paths that escape the configured origin or base path fail before
network transport. Redirects are rejected so credentials cannot follow a
cross-origin or HTTPS-to-HTTP redirect.

Resolve token and authoritative identity together before enabling protected
work. `unavailable` preserves credentials while authority getters fail closed.
Caller abort returns `superseded` without cancelling shared adoption.

```ts
const session = await authStore.resolveSession({ refresh: true, signal });
if (session.status === "ready") {
  // session.token and validated session.user are from one guarded generation
}
```

`ensureAccessToken()` remains a legacy credential-only wrapper. It may return a
retained token while authority is transiently `unavailable`; authority getters
still fail closed. Never use its token as proof that user or organisation
authority is ready. Use `resolveSession()` and require `status === "ready"` for
authorization decisions.

`onSessionStateChange` immediately reports current state. A synchronous
`resolving` notification precedes credential or authority changes, allowing
consumers to suspend writes and clear captured tenant queries first.
`getSessionState()` returns the same guarded state as a defensive snapshot;
continuity capture requires that snapshot to remain `ready`. Internal refresh
and identity requests time out after 10 seconds by default; configure
`resolutionTimeoutMs` on `createAuthStore` when needed.

Authenticated transports that retry after 401 must capture continuity before
their first request and replay only for same validated user and organisation:

```ts
const before = captureSessionContinuity(authStore);
if (!before) throw new Error("Session authority unavailable");
const response = await fetch(url, init);
if (response.status === 401) {
  const after = await resolveSessionForReplay(authStore, before, {
    signal: init.signal,
  });
  if (canReplaySession(before, after, authStore)) {
    // retry once with after.token
  }
}
```

`resolveSessionForReplay` centralizes stale-401 handling. It never refreshes a
replacement session. A ready rotated token can be reused once only when
validated user and organisation still match captured request authority.

### React Components

```tsx
import { LoginForm, RegisterForm, UnauthorizedPage } from "@cellarnode/auth/react";
```

### Dev sign-in bypass (local development only)

`LoginForm` renders an extra "Dev sign-in (skip the code)" control **beside** the
email form when `import.meta.env.DEV` is true. It calls
`authStore.devLogin(email)`, which POSTs the backend's `/test/login` and adopts
the returned JWE through the same path `verifyOtp` uses. The OTP flow is
unchanged and remains the only path in production builds. There is no env var to
set on the frontend.

What is and is not dropped from a production bundle — the distinction matters,
so do not compress it:

- **Dropped.** The `DevSignInBypass` component and its markup. Vite folds
  `import.meta.env.DEV` to `false`, Rollup removes the branch, and the module
  goes with it. Pinned by `__tests__/dev-bypass-treeshake.test.ts`, which
  bundles the form both ways and greps the output.
- **Kept.** `authStore.devLogin` and its failure copy, plus the
  `readDevLoginEmail` / `rememberDevLoginEmail` helpers. All are reached from
  live function bodies behind runtime `if` guards, so no bundler can prove them
  unreachable. They are inert — the helpers only run inside the DEV branch, and
  `devLogin` calls a route that is not mounted in production.

The security boundary is the **server**, not the bundle. `/test/login` is only
mounted when `NODE_ENV`/`MODE` is non-production **and**
`ENABLE_TEST_ENDPOINTS=true`, and every handler re-checks the same predicate.
When it is off, `/test/login` returns a uniform 404 and `devLogin()` resolves to
`{ ok: false, reason: "test-endpoints-disabled" }`. That 404 is deliberately
identical to the "no local account for this address" case, so neither the helper
nor the UI may present it as a statement about the account.

`devLogin()` never rejects; every outcome is a `DevLoginResult`. Callers should
still wrap it, because `devLogin` is optional on the `AuthStore` interface and a
custom store may reject.

```ts
const result = await authStore.devLogin?.("producer@example.com");
if (result?.ok) {
  // session adopted: token set, refresh scheduled, listeners fired
}
```

### Tailwind CSS Content Scan
Add this to your CSS file so Tailwind picks up utility classes from the package:

```css
@source "../node_modules/@cellarnode/auth/dist/**/*.js";
```

## Exports

- `@cellarnode/auth` — Core: `createAuthStore`, `createAuthClient`, `createAuthApi`, `captureSessionContinuity`, `resolveSessionForReplay`, `canReplaySession`, `validateUserType`, `hasEntitlement`, `extractAccessToken`, `AuthError`, session-resolution types, and `DevLoginResult`
- `@cellarnode/auth/react` — React: `LoginForm`, `RegisterForm`, `UnauthorizedPage`, `SquircleShift`, `InputOTP` (+ `Group` / `Slot` / `Separator`)

`DevSignInBypass`, `DEV_LOGIN_EMAIL_STORAGE_KEY`, `readDevLoginEmail` and
`rememberDevLoginEmail` are **deliberately not exported**. They are internals of
`LoginForm`'s `import.meta.env.DEV` branch; the gate lives at that one call site,
and an exported symbol carries no gate — a consumer importing it could render the
bypass UI, or write a sign-in address to `localStorage`, from a production build.

## Publishing

Published to npm (public access) via **npm Trusted Publishing (OIDC)** —
`.github/workflows/publish.yml` publishes automatically on a merge to `main` that changes
`package.json`'s version. There is no long-lived npm token in the publish job, and nobody runs
`npm publish` by hand. Provenance is generated automatically (public repo + public package).

Bump `version` in `package.json` and land it through a normal PR — merging to `main` is what
triggers the publish job, gated on the version having actually changed.

## License

UNLICENSED — Copyright (c) CellarNode. All rights reserved. This package is
published for CellarNode's own applications; no license is granted for
other use.
