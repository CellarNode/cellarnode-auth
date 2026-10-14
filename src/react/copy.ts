/**
 * Localizable copy for the sign-in and register forms (CEL-2572).
 *
 * Both forms used to hard-code their English text, so a host app could translate everything around them and still show an
 * English sign-in. Each form now takes an optional `copy` prop; any field left out keeps the English default below, so existing
 * consumers render exactly what they did before.
 *
 * Placeholders are written `{name}` and filled in by `interpolateCopy` in ONE pass over the template: a value is inserted
 * as plain text and is never scanned again, so a value that itself contains `{email}` (or anything else) cannot inject or expand
 * another placeholder. An unknown placeholder is left as written. Hosts that want markup around a value should build it in their
 * own component and not through this copy (the strings are plain text, not HTML).
 */

/**
 * A copy field that carries placeholders: either a template string with `{name}` tokens, or a function that receives the values and
 * returns the finished text.
 *
 * Prefer the FUNCTION form when the text goes through a translation pipeline. A tool that protects i18next's `{{name}}` (as the
 * workspace's polyglot-i18n does) may translate a bare `{name}` away; with a function the host writes the placeholder in its own
 * native syntax (`t("key", { email })`, `t("key", { count })` for plurals) and the package only calls it. The string form keeps
 * working and is filled in one pass by {@link interpolateCopy}. Either way the result is rendered as plain text.
 */
export type CopyText<Vars> = string | ((vars: Vars) => string);

/** Fill `{name}` placeholders in ONE pass. Values are inserted verbatim and never re-scanned (internal: hosts use the function form). */
export function interpolateCopy(
  template: string,
  values: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}

/** Render a {@link CopyText}: call the function, or interpolate the template with `tokens` (default: the vars themselves). */
export function renderCopy<Vars extends Record<string, string | number>>(
  text: CopyText<Vars>,
  vars: Vars,
  tokens: Readonly<Record<string, string | number>> = vars,
): string {
  return typeof text === "function" ? text(vars) : interpolateCopy(text, tokens);
}

/** Drop `undefined` / `null` values so an explicit `undefined` can never blank (or crash on) a default. */
function definedOnly<T extends object>(copy: Partial<T> | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(copy ?? {}).filter(([, v]) => v !== undefined && v !== null)) as Partial<T>;
}

/**
 * Every user-visible string of `LoginForm`'s email and code steps (heading, description, labels, buttons, Back, the countdowns and
 * the error text).
 *
 * Placeholders: `{email}` (otpSentNotice), `{time}` (expiresIn, resendIn: an mm:ss countdown), `{attempts}` (invalidCode: attempts
 * left), `{userType}` (wrongPortal: the localized role name from `userTypeImporter` / `userTypeProducer`).
 *
 * NOT covered: the "Dev sign-in" control, which is dev-only and compiled out of production builds.
 */
export interface LoginFormCopy {
  /** Top-right button shown when `onBack` is set. */
  back: string;
  /** Banner on the email step in `inviteMode`. */
  inviteBanner: string;
  emailHeading: string;
  emailDescription: string;
  emailLabel: string;
  emailPlaceholder: string;
  /** Submit button of the email step. */
  continue: string;
  otpHeading: string;
  /** Description under the code-step heading. `{email}`. Uniform whether or not the account exists (anti-enumeration). */
  otpSentNotice: CopyText<{ email: string }>;
  /** Countdown badge. `{time}` is mm:ss. */
  expiresIn: CopyText<{ time: string }>;
  verify: string;
  changeEmail: string;
  resendCode: string;
  /** Disabled resend button while the cooldown runs. `{time}` is mm:ss. */
  resendIn: CopyText<{ time: string }>;
  /** Default footer on the email step; the `footerText` prop, when given, wins. */
  footerText: string;
  /** Lead-in of the register link when `showRegisterInFooter` is set. */
  needAccount: string;
  registerHere: string;
  /** `{attempts}` is the number left. A function can use i18next plurals (`count: attempts`). */
  invalidCode: CopyText<{ attempts: number }>;
  rateLimit: string;
  codeExpired: string;
  maxAttempts: string;
  userDeleted: string;
  /** Fallbacks for an error that carries no message of its own. */
  somethingWentWrong: string;
  failedToSendCode: string;
  failedToVerifyCode: string;
  failedToResendCode: string;
  /**
   * A network failure (the browser throws a raw `TypeError`, "Failed to fetch"). Used ONLY when the host supplies it; otherwise the
   * raw message is shown as before.
   */
  networkError: string;
  /** Accessible name of the 6-digit code input. */
  codeInputAriaLabel: string;
  /**
   * Signed in with the wrong kind of account. As a string, `{userType}` is the localized role name (`userTypeImporter` /
   * `userTypeProducer`). As a function it receives the raw portal type (`"importer"` | `"producer"`), so a host can return a
   * COMPLETE sentence per type instead of splicing a noun into one.
   */
  wrongPortal: CopyText<{ userType: "importer" | "producer" }>;
  userTypeImporter: string;
  userTypeProducer: string;
  /**
   * Typed overrides for codes the API and client produce. Each is used ONLY when the host supplies it; without one the server's
   * message is shown as before.
   */
  userNotFound?: string | undefined;
  productFamilyNotAllowed?: string | undefined;
  otpUserInvalid?: string | undefined;
  tokenExtractionFailed?: string | undefined;
  /**
   * Overrides by `AuthError.code` for any other code (including ones this package does not know). Wins over the fields above and
   * over the server's own message, which is English.
   */
  errors: Readonly<Record<string, string>>;
}

export const DEFAULT_LOGIN_FORM_COPY: Readonly<LoginFormCopy> = Object.freeze({
  back: "Back",
  inviteBanner: "Signing in to accept your organization invitation.",
  emailHeading: "Sign in to your account",
  emailDescription: "Enter your work email to receive a one-time access code.",
  emailLabel: "Email address",
  emailPlaceholder: "you@company.com",
  continue: "Continue",
  otpHeading: "Check your email",
  otpSentNotice: "If an account exists for {email}, we've sent a code.",
  expiresIn: "Expires in {time}",
  verify: "Verify",
  changeEmail: "Change email",
  resendCode: "Resend code",
  resendIn: "Resend in {time}",
  footerText: "Need an account? Contact your CellarNode representative.",
  needAccount: "Need an account?",
  registerHere: "Register here",
  invalidCode: "Invalid code. {attempts} attempt(s) remaining.",
  rateLimit: "Too many code requests. Please wait before trying again.",
  codeExpired: "Code expired. Please request a new one.",
  maxAttempts: "Too many failed attempts. Please request a new code.",
  userDeleted: "This account has been deactivated. Contact support.",
  somethingWentWrong: "Something went wrong",
  failedToSendCode: "Failed to send code",
  failedToVerifyCode: "Invalid code",
  failedToResendCode: "Failed to resend code",
  wrongPortal: "This portal is for {userType} accounts only.",
  userTypeImporter: "importer",
  userTypeProducer: "producer",
  networkError: "We couldn't reach the server. Check your connection and try again.",
  codeInputAriaLabel: "Verification code",
  errors: Object.freeze({}),
});

/** Merge a host's partial copy over the English defaults (`errors` merges key by key). */
export function resolveLoginFormCopy(copy?: Partial<LoginFormCopy>): LoginFormCopy {
  return {
    ...DEFAULT_LOGIN_FORM_COPY,
    ...definedOnly(copy),
    errors: { ...DEFAULT_LOGIN_FORM_COPY.errors, ...(definedOnly(copy?.errors) as Record<string, string>) },
  };
}

/**
 * Every user-visible string of the (deprecated) `RegisterForm`. Placeholders: `{email}` (accountCreatedDescription), `{role}`
 * (registerAsDescription: `roleImporter` / `roleProducer`).
 */
export interface RegisterFormCopy {
  accountCreatedHeading: string;
  accountCreatedDescription: CopyText<{ email: string }>;
  goToLogin: string;
  heading: string;
  /** `{role}` is the localized `roleImporter` / `roleProducer` (string form). The function form receives the raw `userType`. */
  registerAsDescription: CopyText<{ role: string; userType: "importer" | "producer" }>;
  roleImporter: string;
  roleProducer: string;
  fullName: string;
  fullNamePlaceholder: string;
  email: string;
  emailPlaceholder: string;
  phone: string;
  phonePlaceholder: string;
  createAccount: string;
  alreadyHaveAccount: string;
  userAlreadyExists: string;
  userDeleted: string;
  registrationClosed: string;
  inviteTokenInvalid: string;
  registrationFailed: string;
  /** A network failure (raw `TypeError`). Used ONLY when the host supplies it. */
  networkError: string;
  /** Overrides by `AuthError.code`, winning over the fields above and the server's English message. */
  errors: Readonly<Record<string, string>>;
}

export const DEFAULT_REGISTER_FORM_COPY: Readonly<RegisterFormCopy> = Object.freeze({
  accountCreatedHeading: "Account created",
  accountCreatedDescription:
    "Your account has been created. Log in with a one-time code sent to {email} to get started.",
  goToLogin: "Go to Login",
  heading: "Create an account",
  registerAsDescription: "Register as {role} to get started",
  roleImporter: "an importer",
  roleProducer: "a producer",
  fullName: "Full name",
  fullNamePlaceholder: "Jane Doe",
  email: "Email",
  emailPlaceholder: "you@company.com",
  phone: "Phone (optional)",
  phonePlaceholder: "+1 555 123 4567",
  createAccount: "Create account",
  alreadyHaveAccount: "Already have an account? Log in",
  userAlreadyExists: "An account with this email already exists. Please log in instead.",
  userDeleted: "This account has been deactivated. Please contact support.",
  registrationClosed:
    "Registration is invite-only. Please use the sign-up link from your invite email.",
  inviteTokenInvalid:
    "Your invitation is invalid, expired, or was sent to a different email address. Ask your organisation admin to resend it.",
  registrationFailed: "Registration failed",
  networkError: "We couldn't reach the server. Check your connection and try again.",
  errors: Object.freeze({}),
});

export function resolveRegisterFormCopy(copy?: Partial<RegisterFormCopy>): RegisterFormCopy {
  return {
    ...DEFAULT_REGISTER_FORM_COPY,
    ...definedOnly(copy),
    errors: { ...DEFAULT_REGISTER_FORM_COPY.errors, ...(definedOnly(copy?.errors) as Record<string, string>) },
  };
}
