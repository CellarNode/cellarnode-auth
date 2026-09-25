# Changelog

## 0.19.0

### Added
- `RegisterInput.registrationToken` (CEL-2087 phase 3) — the confirm-first proof of email ownership from `POST /auth/registration/verify-code`, forwarded verbatim by `authApi.register()`. The backend's public `/auth/register` route now requires it: absent gets `400 REGISTRATION_TOKEN_REQUIRED`, invalid/expired/wrong-email gets `400 REGISTRATION_TOKEN_INVALID`. Peeked, not consumed, by the backend — a subsequent `POST /auth/registration/session` call with the same token mints the session.

### Deprecated
- `RegisterForm` (CEL-2087) — registers directly with no proof the caller controls the submitted email, so its plain `register()` call now fails the backend's phase-3 confirm-first requirement above for every consumer. Build a confirm-first flow instead: `OtpConfirmationStep` to collect and verify a code, then pass the resulting token as `RegisterInput.registrationToken`. Not removed yet; see `producer-dashboard`'s and `cellarnode-importer-dashboard`'s `src/routes/create-account.tsx` for a reference implementation.

## 0.18.0

### Added
- `SessionState` gains a `"revalidating"` status (CEL-2086), distinct from `"resolving"`: published whenever a background operation (scheduled token renewal, a forced `resolveSession({ refresh: true })`, or a non-rotating `revalidateSession()` remint) starts while a confirmed `"ready"` session already exists. It carries the last CONFIRMED `user` and `confirmedToken` — never a freshly rotated, not-yet-verified candidate token — so consumers can keep their mounted workspace and identity displayed instead of flashing a full "verifying session" screen on routine background checks, without ever pairing an unverified credential with a stale org (CEL-2086 review round 1). `"resolving"` is now reserved for cold start, a truly unauthenticated caller, and explicit new-credential adoption (`setAccessToken`, OTP/dev login) — the latter always publishes `"resolving"` even when a different account was previously `"ready"`, since a new credential has no confirmed continuity with the old one. `captureSessionContinuity`/`resolveSessionForReplay` (and `auth-client`'s 401 retry) treat `"revalidating"` the same as `"resolving"`/`"unavailable"` for the purposes of suspending protected writes and detecting a superseded replay, comparing against `confirmedToken` for the revalidating case.
- `OtpConfirmationStep` (`@cellarnode/auth/react`) — a shared six-digit OTP confirmation interaction (auto-advance, backspace/arrow nav, paste, `autocomplete="one-time-code"`, digits-only `pattern`, a one-flight request-on-mount guard, a resend countdown bound to the server's real `resendAvailableAt`/`expiresAt` (preferring server-computed relative seconds when present, clock-skew safe), an expired-code notice, invalid/expired/max-attempts/rate-limit error mapping) built on the existing `InputOTP` primitives (which separately provide the reduced-motion and mobile-sized rendering). Transport- and copy-agnostic: callers supply `onRequestCode`/`onVerifyCode` and an explicit `labels` prop (CEL-2087).
  - `initialTimings` prop for a code already sent before this step mounts (e.g. producer's flow); pair with `autoRequestOnMount={false}`.
  - An explicit idle "Send code" state when `autoRequestOnMount={false}` and no `initialTimings` are given, so the step is never stuck showing "Sending code…" indefinitely.
  - Accessibility: `aria-invalid`/`aria-describedby` link the input to its error, a failed request always leaves resend actionable, the input stays `readOnly` (not `disabled`) and refocuses after a failed verify, and a successful resend is announced via `aria-live="polite"`.

### Fixed
- A post-token-rotation identity read (scheduled renewal, forced refresh, or a `revalidateSession()` remint) that disagreed with the last confirmed baseline's `orgId` was adopted or escalated on a SINGLE read, with no way to distinguish a genuine org change from a transient backend inconsistency right after rotation (CEL-2086; observed as producer-dashboard's route guard transiently redirecting a ready user with an org to `/organisation` on an `orgId: null` blip). Such an org divergence is now re-checked once more with an independent `/auth/me` read on the same (already rotated) token: a divergence that does not repeat is discarded in favor of the baseline, a divergence that repeats is adopted as a real org change, and two reads that disagree with each other AND the baseline suspend the session (`"unavailable"`) rather than guess.
- A post-token-rotation identity read reporting a DIFFERENT USER ID than the last confirmed baseline now fails closed (`"unauthorized"`) immediately, with no corroborating re-read — user id is bound to the token, so a second read (even one reporting the original user again) must never resurrect `"ready"` (CEL-2086 review round 1). Only an `orgId` divergence gets the corroborating re-read above.
- `RegisterForm`'s post-registration success screen no longer claims a verification link was sent — no surface using this component ever sends one. Copy now accurately describes signing in with a one-time code (CEL-1810).

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
