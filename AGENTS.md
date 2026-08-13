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
npm install
npm run typecheck       # tsc --noEmit
npm test                # vitest run
npm run build           # tsc
npx publint             # package.json / exports lint
```

Those four are exactly the CI steps — run all four before opening a PR. There is
no Makefile in this repo; an earlier revision of this file recommended
`make build`, which never existed here.

## Exports

```
@cellarnode/auth        # Core: store + client + api + guard helpers + types
@cellarnode/auth/react  # LoginForm, RegisterForm, UnauthorizedPage, SquircleShift,
                        # InputOTP (+ Group / Slot / Separator)
```

The dev-bypass internals (`DevSignInBypass`, `DEV_LOGIN_EMAIL_STORAGE_KEY`,
`readDevLoginEmail`, `rememberDevLoginEmail`) are NOT exported from
`@cellarnode/auth/react` — see "Dev sign-in bypass" below.

### Core API

- `createAuthStore({ baseUrl })` — token persistence (localStorage in browser; mobile uses an `expo-secure-store` adapter on the consumer side). Also exposes `devLogin(email)` (CEL-1364) — see "Dev sign-in bypass".
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
└── react/              # LoginForm, RegisterForm, UnauthorizedPage, SquircleShift,
                        # InputOTP; plus dev-sign-in.tsx (INTERNAL — not in the
                        # react barrel)
```

## Dev sign-in bypass (CEL-1364)

`LoginForm` renders a "Dev sign-in (skip the code)" control **alongside** the
email form, and `AuthStore.devLogin(email)` backs it by POSTing the backend's
`POST /test/login` and adopting the returned JWE through `setAccessToken()` —
the same adoption path `verifyOtp` uses (same identity fetch, same refresh
scheduling, same listener fan-out).

Rules that must not drift:

- **Additive only.** The OTP flow is untouched, always rendered, never
  auto-skipped, never auto-redirected. The OTP page stays testable.
- **The two affordances must not race, in BOTH directions.** The bypass button
  is disabled while the OTP form is busy, AND the OTP "Continue" button is
  disabled while the bypass is in flight. Drop the second half and a developer
  can advance to the OTP step mid-`devLogin`, after which the resolving bypass
  calls `onLoginSuccess()` from a step that no longer renders it.
- **Every failure reaches the UI.** `handleDevLogin` catches as well as
  `finally`s. `devLogin` is optional on `AuthStore`, so a custom store may
  reject; from a click handler that would be an unhandled rejection and the
  button would silently re-enable with no message.
- **Fails closed.** The dev path resolves the user type through a separate
  `GET /auth/me` (verify-otp gets it inline). If that call fails or answers
  without a `userType`, the bypass clears the token and errors — an
  unresolvable type is never treated as a passing portal check.
- **Not exported.** `DevSignInBypass` and the three storage symbols are absent
  from `src/react/index.ts` on purpose. The gate is the single
  `import.meta.env.DEV` call site inside `LoginForm`; an exported symbol has no
  gate, and a consumer could render the bypass or write to `localStorage` from a
  production build. Tests import `../src/react/dev-sign-in.js` directly.
- **No new env vars.** The frontend gate is the literal `import.meta.env.DEV`.
  The backend gate stays `ENABLE_TEST_ENDPOINTS`. Do not add a `VITE_*` flag.
- **Be exact about what production drops.** Only the `DevSignInBypass`
  COMPONENT is statically eliminated (Vite folds the literal, Rollup drops the
  branch and the module; pinned by `__tests__/dev-bypass-treeshake.test.ts`,
  which bundles the form both ways through esbuild and greps the output).
  `authStore.devLogin`, its failure copy, and `readDevLoginEmail` /
  `rememberDevLoginEmail` all sit in live function bodies behind runtime guards
  and SHIP. Do not write docs or comments claiming otherwise.
- **The gate is the server, not the bundle.** `POST /test/login` is only mounted
  when `!isProdLike() && ENABLE_TEST_ENDPOINTS === "true"`, and each handler
  re-checks the same predicate, so in production the route does not exist and a
  shipped `devLogin` can only resolve `test-endpoints-disabled`. A runtime
  `import.meta.env.DEV` check inside `devLogin` was considered and declined: the
  core entry is bundler-agnostic (`import.meta.env` is `undefined` under plain
  Node ESM, so reading `.DEV` would THROW out of a method contracted never to),
  and it would eliminate no code, since the guard sits in the same live body.
- **Anti-enumeration (backend T3-1).** `/test/login` returns the SAME 404 for
  "gate off" and "no such account". `devLogin()` maps it to the single reason
  `"test-endpoints-disabled"` and frames the copy as "set
  `ENABLE_TEST_ENDPOINTS=true`" — never as a claim about the address.
- **`devLogin()` never rejects.** Every outcome, including a body that parses as
  literal `null`, comes back as a `DevLoginResult`; its only caller is a click
  handler with no other error channel.
- `devLogin` is **optional** on the `AuthStore` interface so custom store
  implementations stay source-compatible; `createAuthStore()` always provides it.
- Optional prefill: `localStorage["cellarnode.dev.login-email"]`, read and
  written only behind `import.meta.env.DEV`.

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
| POST | `/test/login` | LOCAL DEV ONLY (CEL-1364). Body `{ email }` → `{ accessToken, userId, orgId }` + the OTP flow's refresh cookies. 404s uniformly unless the API runs with `ENABLE_TEST_ENDPOINTS=true` outside production. |

Session TTL defaults: access 15min, refresh 7d. See `cellarnode-backend-v2/AGENTS.md` for the full server-side schema.
