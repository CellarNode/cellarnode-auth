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
