# @cellarnode/auth

Shared OTP-based authentication for CellarNode dashboards — token store, API client, React UI components.

## Install

```bash
npm install @cellarnode/auth
```

## Usage

### Core (framework-agnostic)

```ts
import { createAuthStore, createAuthClient, createAuthApi } from "@cellarnode/auth";

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

### React Components

```tsx
import { LoginForm, RegisterForm, UnauthorizedPage } from "@cellarnode/auth/react";
```

### Dev sign-in bypass (local development only)

`LoginForm` renders an extra "Dev sign-in (skip the code)" control **beside** the
email form when `import.meta.env.DEV` is true. It calls
`authStore.devLogin(email)`, which POSTs the backend's `/test/login` and adopts
the returned JWE through the same path `verifyOtp` uses. The OTP flow is
unchanged and remains the only path in production builds — Vite folds
`import.meta.env.DEV` to `false`, so the control and its module are dropped from
the bundle. There is no env var to set on the frontend.

The backend side is gated by `ENABLE_TEST_ENDPOINTS=true` (non-production only).
When it is off, `/test/login` returns a uniform 404 and `devLogin()` resolves to
`{ ok: false, reason: "test-endpoints-disabled" }`. That 404 is deliberately
identical to the "no local account for this address" case, so neither the helper
nor the UI may present it as a statement about the account.

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

- `@cellarnode/auth` — Core: `createAuthStore`, `createAuthClient`, `createAuthApi`, `validateUserType`, types
- `@cellarnode/auth/react` — React: `LoginForm`, `RegisterForm`, `UnauthorizedPage`, `SquircleShift`

## License

MIT
