# Changelog

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
