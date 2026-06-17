# @cellarnode/auth

Shared OTP-based authentication — token store, API client, React UI components for CellarNode customer-facing dashboards.

## Scope

Powers OTP auth in: `producer-dashboard`, `cellarnode-importer-dashboard`, `cellarnode-mobile-app`, `cellarnode-elabel-frontend` (producer-side `/app/*`).

**NOT used by:**
- `cellarnode-admin-dashboard-v2` — uses GitHub OAuth BFF (CEL-142+, see root AGENTS.md "Authentication / SSO Direction").
- `cellarnode-public-site` — marketing-only, no auth.

## Stack

- TypeScript 5.x. Framework-agnostic core + React subpath.
- JWE/HS256 tokens (decrypted server-side by backend V2's `authGuard()`).
- Built with `tsc` (no bundler). Tested with vitest.

## Commands

```bash
pnpm install
pnpm build              # tsc only
pnpm test               # vitest run
make build              # clean + lint + typecheck + compile (PREFERRED pre-publish gate)
```

Always `make build` before opening a PR or publishing.

## Exports

```
@cellarnode/auth        # Core: store + client + api + types
@cellarnode/auth/react  # LoginForm, RegisterForm, UnauthorizedPage, SquircleShift
```

### Core API

- `createAuthStore({ baseUrl })` — token persistence (localStorage in browser; mobile uses an `expo-secure-store` adapter on the consumer side).
- `createAuthClient({ baseUrl, store, onAuthFailure })` — fetch wrapper, auto-attaches Bearer, calls `onAuthFailure` on 401.
- `createAuthApi({ client, store })` — typed login/register/logout helpers.
- `validateUserType(userType)` — `"producer" | "importer" | "distributor" | "admin"`.

## Structure

```
src/
├── index.ts
├── auth-api.ts         # API wrapper (login/register/logout/refresh)
├── auth-client.ts      # fetch + retry + auth header
├── auth-guard.ts       # Client-side guard helpers
├── auth-store.ts       # Token storage abstraction
├── extract-token.ts    # JWT extraction helpers
├── types.ts            # AuthStore, AuthClient, UserType, ...
└── react/              # LoginForm, RegisterForm, UnauthorizedPage, SquircleShift
```

## Tailwind v4 content scan (consumer step)

When using `@cellarnode/auth/react`, consumers must register the lib's compiled JS so Tailwind picks up the utility classes inside the React components:

```css
/* in consumer's main CSS */
@source "../node_modules/@cellarnode/auth/dist/**/*.js";
```

## Backend contract

OTP flow against backend V2 public API (port 4000):

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/otp/request` | Send OTP via SendGrid |
| POST | `/auth/otp/verify` | Exchange OTP for JWE access + refresh tokens |
| POST | `/auth/refresh` | Rotate access token (replay-detection revokes session) |
| POST | `/auth/logout` | Revoke session in Redis (`cellarnode:session:*`) |
| GET | `/auth/me` | Current user; backend `authGuard()` accepts EITHER Bearer JWE (OTP path) OR cookie (admin BFF path). Cookie wins. |

Session TTL defaults: access 15min, refresh 7d. See `cellarnode-backend-v2/AGENTS.md` for the full server-side schema.
