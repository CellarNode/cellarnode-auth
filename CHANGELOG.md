# Changelog

## 0.9.0

### Added
- `getUserId() / getOrgId() / getUserType() / getSessionClaims()` — decode the current access token without a server round-trip.
- `onOrgChange` / `onAccessTokenSet` / `onLogout` event subscriptions.

### Changed
- `setAccessToken()` now decodes the JWT and emits change events. `onOrgChange` fires only when `orgId` actually changes (no-op on same-orgId refresh).

### Deps
- Adds `jose@^6.x` (client-side decode only; signature verification stays server-side).
