# Changelog

## [Unreleased]

### Added
- `fetchImpl` config on `AuthStoreConfig` and `AuthClientConfig` (CEL-2208):
  non-browser hosts (the CellarNode MCP server) inject a cookie-jar-aware
  fetch for refresh/identity/client transport. Browsers are unchanged
  (defaults to global fetch).

## 0.20.3

### Fixed
- **A late `offline` after a refresh TypeError now counts as a drop during the refresh** (CEL-2123, review P3). Browsers can flip `navigator.onLine` a moment after the fetch rejects (about 50ms in the review probe). 0.20.2 only recognised a drop when the device was already offline at the moment the error arrived, so such a drop went unrecorded, and the next retry could re-present a committed cookie (`REFRESH_REPLAYED`).
  - After a network `TypeError` while still online, the store now watches for the `offline` event for `LATE_OFFLINE_WATCH_MS` (2s, below the first backoff retry of at least 4s).
  - If `offline` fires, it records a possibly-committed rotation, drops the pending backoff retry and applies the 0.20.2 offline hold.
  - No event within 2s keeps the ordinary backoff.
  - The watch ends when its timer expires, on a successful rotation, and on a sign-out or new sign-in.

## 0.20.2

### Fixed
- **Offline no longer signs the user out mid-outage** (CEL-2123). A refresh that timed out records a possibly-committed rotation (0.20.0). Before, the 1.5s quick retries failed fast while the device stayed offline, and 8s after the send the tab failed closed: `unauthorized / session-uncertain`, while the user was still offline.
  - Now, while `navigator.onLine` is false and a rotation may have committed, the tab stays `unavailable`. It neither presents the refresh cookie nor fails closed, and it schedules no quick retries.
  - It decides once, on the browser's `online` event. Back inside the commit window, it re-presents (the backend grace makes that idempotent). Past it, it still fails closed as before.
  - Being offline is never treated as proof that the timed-out request was not delivered: that could re-present a committed cookie outside the grace, which is `REFRESH_REPLAYED` and signs out every device in the family. The sign-out after a genuinely ambiguous lost response is deferred until the device is back online, not removed.
  - Online behaviour is unchanged.
  - A network drop DURING a refresh is now treated like a timeout (pre-existing since 0.20.0, review P2). The server may have committed the rotation before the connection died, and the client then sees only a fast `TypeError`. Such a `TypeError` (online at send, offline when it fails) now records a possibly-committed rotation, and the offline hold covers it. Before, the old cookie was re-presented later and could be `REFRESH_REPLAYED`. A `TypeError` when the device was already offline at send is unchanged: the request never left, so nothing is recorded.
  - The hold also resumes for a cold store (a reload while offline inside the uncertainty, with no in-memory token). A sign-out or a new sign-in cancels a pending hold, so the new session is not force-rotated when the device comes back online.

## 0.20.1

### Added
- `endSessionUncertainty()` on the concrete store (CEL-2107). It ends a `session-uncertain` state. `authApi.logout()` and `authApi.signOutEverywhere()` call it after the server confirmed the session is gone; a local `clearAccessToken()` never does.

### Fixed
- **0.20.0 bug:** a local `clearAccessToken()` ended the `session-uncertain` fail-closed state (CEL-2107, P1). Every consumer calls `clearAccessToken()` right after the `session-uncertain` bounce, and that wiped the uncertainty, so the sign-in page's cold refresh presented the old refresh cookie minutes later. That meant `REFRESH_REPLAYED` and every device in the family signed out, which defeated the fail-closed. Now only a confirmed rotation, an explicit new sign-in, or a server-confirmed logout ends it, in this tab or any other.
- A possibly-committed time in the FUTURE (the device clock was set back) now counts as expired: the tab fails closed instead of presenting.
- A confirmed rotation now removes the stored possibly-committed timestamp.
- An explicit sign-in (or any confirmed rotation) supersedes a future-dated uncertainty (clock set back). Before, no later send could ever be "after" it, so the user stayed stuck in `session-uncertain`.
- The commit-window uncertainty is now shared by every same-origin tab (CEL-2107, residual B). Tabs share one refresh cookie jar, so a rotation that tab A may have committed (lost response) makes tab B's old cookie just as unsafe to present after the backend's grace.
  - The possibly-committed send time moved from `sessionStorage` to `localStorage`, and every tab's refresh reads it fresh. Tab B presents only inside A's commit window, and after it fails closed as `session-uncertain`.
  - A shared `last-confirmed-rotation-at` (the SEND time of the confirming refresh, or of an explicit new sign-in) lets any tab's confirmed rotation clear the uncertainty for all tabs. The jar then holds a live cookie, so a recovered tab no longer forces an extra sign-in elsewhere.
  - The storage key uses `new URL(baseUrl).origin`, so a trailing slash or a path never splits one API into two keys. Timestamps only, never a token. Storage failures fall back to memory.

## 0.20.0

### Added
- `SessionState`'s `unauthorized` status can carry `reason: "account-changed"` (new `SessionEndReason` type, CEL-2107). It is set when a rotation through the shared refresh cookie returns a different user than the confirmed one, which happens when another tab signed in as someone else. The session still fails closed exactly as before (token cleared, `unauthorized`), but consumers can now reload into the new account's workspace instead of sending the user to sign-in. This is additive: the reason is optional and absent on an ordinary sign-out.

- `SessionEndReason` also includes `"session-uncertain"` (CEL-2107). It is published with `unauthorized` when a refresh may have been committed server-side but its response was lost and the backend's replay grace has passed. The tab stops presenting its refresh cookie and ends locally; consumers show sign-in (see Fixed).

### Fixed
- A renewal that fails on the network no longer turns into a sign-out (CEL-2107). A `/auth/me` 401 on a confirmed session whose token was not just rotated (the access token expired because its renewal could not run) now asks the refresh cookie once before giving up. Only a refused rotation (401/403) publishes `unauthorized`, and a rotation that fails on the network stays `unavailable`. Before, the 401 cleared the session immediately, so a transient outage plus expiry tore a valid session down (the producer landed on /login although the session was still valid).
- A failed scheduled renewal is retried in the background (CEL-2107). A renewal that fails before a new token is adopted (network, 5xx, malformed response) used to re-arm nothing, so the access token simply expired. It is now retried after about 5s, 15s, 30s, then every 60s while a credential is held. Each delay has ±20% jitter, so tabs that failed together don't retry in lockstep, and a hidden tab defers its retry until it is visible again. Retries share the scheduled renewal's single timer, so the two never stack. They stop on sign-out or when a rotation is refused, and the backoff resets on the next successful rotation.
- A refresh whose response is lost can no longer revoke the session family (CEL-2107).
  - The refresh POST has its own 4s deadline, previously the shared 10s resolution timeout.
  - The backend treats an old cookie presented again within 10s of the rotation as an idempotent duplicate. Outside that window it answers `REFRESH_REPLAYED` and revokes every device in the family.
  - So after a refresh TIMES OUT (the server may have committed it), the tab keeps presenting its cookie only within 8s of that request's send. It retries any failure in that window after about 1.5s, never deferred for a hidden tab.
  - If the rotation is still unconfirmed after that, the tab never presents the cookie again: no background retry, no "Try again" renewal, no read-401 fallback, no cold resolve. It fails closed locally instead: the token is cleared and `unauthorized` is published with the new `SessionEndReason` `"session-uncertain"`, so the app shows sign-in.
  - Signing one tab in again beats revoking every device. A new explicit sign-in or a confirmed rotation ends the uncertainty.
  - A late timer (for example Chrome's intensive throttling of hidden tabs) hits the same window check and fails closed.
  - The uncertainty survives a reload. Only the timestamp (never a token) is kept in `sessionStorage`, keyed per product family and API origin, and read when the store is created. So a cold resolve in a reloaded tab can't present the cookie late either; that tab also ends as `session-uncertain`. If storage is unavailable or throws, it falls back to memory.
- `revalidateSession()` renews while a renewal is owed (CEL-2107). A remint keeps the old expiry, so a "Try again" after a failed renewal restored the session for only a few seconds. When the last renewal failed, or the access token is within `refreshBuffer` of expiry, `revalidateSession()` now rotates through the refresh cookie instead. Otherwise it still remints without spending the refresh cookie (CEL-1853).

### Internal
- `otp-confirmation-step.paste.test.tsx` no longer crashes teardown intermittently. The real `input-otp` schedules selection-sync timers (0/10/50ms) that it never clears on unmount. The test now unmounts, then waits them out before happy-dom is torn down. Before the fix, 1 in 3 `npm test` runs failed with "window is not defined", which would also fail the publish job.

## 0.19.0

### Added
- `RegisterInput.registrationToken` (CEL-2087 phase 3) — the confirm-first proof of email ownership from `POST /auth/registration/verify-code`, forwarded verbatim by `authApi.register()`. The backend's public `/auth/register` route will require it once backend phase 3 deploys: from then on, absent gets `400 REGISTRATION_TOKEN_REQUIRED`. Once the backend's optional-token check (backend PR #868) deploys, invalid/expired/wrong-email gets `400 REGISTRATION_TOKEN_INVALID`. Peeked, not consumed, by the backend — a subsequent `POST /auth/registration/session` call with the same token mints the session.

### Deprecated
- `RegisterForm` (CEL-2087) — registers directly with no proof the caller controls the submitted email, so once backend phase 3 deploys, its plain `register()` call fails the confirm-first requirement above for every consumer. Build a confirm-first flow instead: `OtpConfirmationStep` to collect and verify a code, then pass the resulting token as `RegisterInput.registrationToken`. Not removed yet. For a reference implementation, see `cellarnode-importer-dashboard`'s `src/routes/create-account.tsx` (on main); producer-dashboard PR #869 adds the producer equivalent.

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
