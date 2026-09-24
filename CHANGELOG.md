# Changelog

## Unreleased

### Added
- `SessionState` gains a `"revalidating"` status (CEL-2086), distinct from `"resolving"`: published whenever a background operation (scheduled token renewal, a forced `resolveSession({ refresh: true })`, or a non-rotating `revalidateSession()` remint) starts while a confirmed `"ready"` session already exists. It carries the last CONFIRMED `token`/`user` so consumers can keep their mounted workspace and identity displayed instead of flashing a full "verifying session" screen on routine background checks. `"resolving"` is now reserved for cold start, a truly unauthenticated caller, and explicit new-credential adoption (`setAccessToken`, OTP/dev login) — the latter always publishes `"resolving"` even when a different account was previously `"ready"`, since a new credential has no confirmed continuity with the old one. `captureSessionContinuity`/`resolveSessionForReplay` (and `auth-client`'s 401 retry) treat `"revalidating"` the same as `"resolving"`/`"unavailable"` for the purposes of suspending protected writes and detecting a superseded replay.

## 0.17.2

### Fixed
- License metadata corrected to UNLICENSED; public access (CEL-1981).

## 0.17.1

### Added
- `RegisterForm` / `RegisterInput` accept an org-invite `token` prop and forward it in the registration body (CEL-1814), and map the backend's closed/invalid registration errors (`REGISTRATION_CLOSED`, `INVITE_TOKEN_INVALID`, `IMPORTER_INVITE_REQUIRED`) to actionable form feedback.

## 0.17.0

### Added
- `SessionFamily` (`"producer" | "elabel"`), `SESSION_FAMILY_HEADER`, `refreshCookieNameFor`, `isSessionFamily`, and `withProductFamily` from `@cellarnode/auth` (CEL-1722). `createAuthStore` accepts `productFamily` and declares it on the refresh request header and the OTP verify body, so a producer tab and an e-label tab on the same origin rotate independent family-scoped refresh cookies (`cn_rt_producer` / `cn_rt_elabel`) and stay signed in concurrently. `getProductFamily()` reports the configured family; family-less stores keep the exact legacy wire shape.
- `signOutEverywhere()` on the auth API (CEL-1722) — calls `POST /auth/sessions/revoke-all` with the current Bearer token and clears local credentials, revoking every session family including the caller's. On 401 the local state is still cleared; non-401 errors propagate.

### Fixed
- Pinning test suite for serialized scheduled/forced refresh (CEL-1721): timer+forced overlap sends one request, concurrent callers share the result, a late response cannot resurrect a logged-out session or overwrite a newer user's token. Documents the already-fixed single-flight behavior of `resolveSession` for future regressions.

## 0.16.0

### Added
- `revalidateSession({ signal? })` on `ConcreteAuthStore` and optional `revalidatePath` config (default `/auth/revalidate`) for non-rotating authority remint (CEL-1853). Concurrent remints single-flight; joins an in-flight refresh/adoption; preserves the absolute refresh deadline/timer; one `ACCESS_TOKEN_EXPIRED` fallback to ordinary refresh only.

## 0.15.0

### Added
- Session resolution APIs: `resolveSession`, `getSessionState`, `onSessionStateChange`, continuity capture, and guarded 401 replay. Refresh and identity resolution are generation-checked, single-flight, and bounded by `resolutionTimeoutMs`.
- `VerifyOtpUser` models the sparse user projection returned by `/auth/verify-otp`; `/auth/me` continues to return fully validated `AuthUser`.

### Changed
- Package-owned auth requests require HTTPS. Exact loopback hosts `localhost`, `127.0.0.1`, and `[::1]` retain automatic HTTP support for local development. Unsafe URLs and redirects fail before credentials can leave the configured origin and base path.
- Session-facing `userType` accepts `"distributor"` and nullable profile values. Consumers must handle `null` before portal routing.

### Breaking changes
- `VerifyOtpResponse.user` is now `VerifyOtpUser`, which omits `createdAt` and `entitlements`. Code requiring those full-profile fields must call `getMe()` or resolve the session.
- `AuthUser.userType` now permits `"distributor"` and `null`. Exhaustive switches and portal routing must handle both values.
- Protected startup and 401 retry flows should use the session-resolution API so token, user, and organisation authority come from one guarded generation.

## 0.14.0

### Added
- `AuthStore.devLogin(email)` (CEL-1364) — LOCAL-DEV helper that mints a session from the backend's `POST /test/login` and adopts the JWE through the same path `verifyOtp` uses (identity fetch, refresh scheduling, `onAccessTokenSet` / `onOrgChange` fan-out). Returns a `DevLoginResult` instead of throwing; the backend's uniform 404 maps to `reason: "test-endpoints-disabled"` with a "set `ENABLE_TEST_ENDPOINTS=true`" hint, never a claim about the address. Optional on the interface, so custom `AuthStore` implementations stay source-compatible.
- `LoginForm` renders a DEV-only "Dev sign-in (skip the code)" control **alongside** the email form — additive, never a replacement, no auto-redirect. Gated on the literal `import.meta.env.DEV`, so production builds tree-shake the control away (asserted against real bundler output, not just the runtime conditional). It applies the same portal guard as the OTP path and fails closed: if `/auth/me` cannot resolve a `userType`, the token is cleared instead of the session standing. While the bypass is in flight the OTP "Continue" button is disabled, so the two affordances cannot race. No new env vars.
- `DevLoginResult` / `DevLoginSuccess` / `DevLoginFailure` / `DevLoginFailureReason` types from `@cellarnode/auth`. The bypass internals (`DevSignInBypass`, `readDevLoginEmail`, `rememberDevLoginEmail`, `DEV_LOGIN_EMAIL_STORAGE_KEY`) are intentionally NOT exported from `@cellarnode/auth/react` — the DEV gate lives at `LoginForm`'s single call site, and an exported symbol would carry none. Note that `devLogin` itself and its failure copy do ship in production bundles; the gate is the server-side `ENABLE_TEST_ENDPOINTS` mount check, so the route simply does not exist there.

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
