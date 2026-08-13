"use client";

export { LoginForm, type LoginFormProps } from "./login-form.js";
/*
 * `./dev-sign-in.js` is DELIBERATELY not re-exported (CEL-1364).
 *
 * `DevSignInBypass`, `DEV_LOGIN_EMAIL_STORAGE_KEY`, `readDevLoginEmail` and
 * `rememberDevLoginEmail` are internals of `LoginForm`'s
 * `import.meta.env.DEV` branch. Naming them here would hand a consumer a
 * supported way to render the bypass UI, or to persist a sign-in address to
 * `localStorage`, from a PRODUCTION build — the gate lives at the single call
 * site inside `LoginForm`, and an exported symbol has no gate at all.
 * Import the module path directly if you are testing this package.
 */
export { RegisterForm, type RegisterFormProps } from "./register-form.js";
export {
  UnauthorizedPage,
  type UnauthorizedPageProps,
  type UnauthorizedPageLabels,
} from "./unauthorized.js";
export type { DashboardLink } from "../types.js";
export { SquircleShift, type SquircleShiftProps } from "./squircle-shift.js";
export {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
  InputOTPSeparator,
  type InputOTPProps,
} from "./input-otp-slots.js";
