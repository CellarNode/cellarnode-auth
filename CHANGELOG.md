# Changelog

## 0.14.0

### Added
- `AuthStore.devLogin(email)` (CEL-1364) — LOCAL-DEV helper that mints a session from the backend's `POST /test/login` and adopts the JWE through the same path `verifyOtp` uses (identity fetch, refresh scheduling, `onAccessTokenSet` / `onOrgChange` fan-out). Returns a `DevLoginResult` instead of throwing; the backend's uniform 404 maps to `reason: "test-endpoints-disabled"` with a "set `ENABLE_TEST_ENDPOINTS=true`" hint, never a claim about the address. Optional on the interface, so custom `AuthStore` implementations stay source-compatible.
- `LoginForm` renders a DEV-only "Dev sign-in (skip the code)" control **alongside** the email form — additive, never a replacement, no auto-redirect. Gated on the literal `import.meta.env.DEV`, so production builds tree-shake the control away (asserted against real bundler output, not just the runtime conditional). It applies the same portal guard as the OTP path and fails closed: if `/auth/me` cannot resolve a `userType`, the token is cleared instead of the session standing. No new env vars.
- `DevSignInBypass`, `readDevLoginEmail`, `rememberDevLoginEmail`, `DEV_LOGIN_EMAIL_STORAGE_KEY` from `@cellarnode/auth/react`; `DevLoginResult` / `DevLoginSuccess` / `DevLoginFailure` / `DevLoginFailureReason` types from `@cellarnode/auth`.

## 0.13.3

### Fixed
- SquircleShift and OTP feedback now honor `prefers-reduced-motion` without losing visible error and focus feedback.

## 0.13.2

### Fixed
- React OTP inputs now keep configurable 4, 6, and 8-digit layouts within narrow screens without horizontal overflow.
- OTP selector and separator semantics remain compatible with existing consumers.

## 0.13.1

### Fixed
- React login, registration, and unauthorized surfaces now pair semantic backgrounds with matching foreground colors in light and dark themes.

## 0.9.0

### Added
- `getUserId() / getOrgId() / getUserType() / getSessionClaims()` — decode the current access token without a server round-trip.
- `onOrgChange` / `onAccessTokenSet` / `onLogout` event subscriptions.

### Changed
- `setAccessToken()` now decodes the JWT and emits change events. `onOrgChange` fires only when `orgId` actually changes (no-op on same-orgId refresh).

### Deps
- Adds `jose@^6.x` (client-side decode only; signature verification stays server-side).
