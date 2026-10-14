/**
 * Localizable copy for the sign-in and register forms (CEL-2572).
 *
 * Both forms used to hard-code their English text, so a host app could translate everything around them and still show an
 * English sign-in. Each form now takes an optional `copy` prop; any field left out keeps the English default below, so existing
 * consumers render exactly what they did before.
 *
 * Placeholders are written `{name}` and filled in by {@link interpolateCopy} in ONE pass over the template: a value is inserted
 * as plain text and is never scanned again, so a value that itself contains `{email}` (or anything else) cannot inject or expand
 * another placeholder. An unknown placeholder is left as written. Hosts that want markup around a value should build it in their
 * own component and not through this copy (the strings are plain text, not HTML).
 */

/** Fill `{name}` placeholders in one pass. Values are inserted verbatim and never re-scanned. */
export function interpolateCopy(
  template: string,
  values: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
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
  otpSentNotice: string;
  /** Countdown badge. `{time}` is mm:ss. */
  expiresIn: string;
  verify: string;
  changeEmail: string;
  resendCode: string;
  /** Disabled resend button while the cooldown runs. `{time}` is mm:ss. */
  resendIn: string;
  /** Default footer on the email step; the `footerText` prop, when given, wins. */
  footerText: string;
  /** Lead-in of the register link when `showRegisterInFooter` is set. */
  needAccount: string;
  registerHere: string;
  /** `{attempts}` is the number left. */
  invalidCode: string;
  rateLimit: string;
  codeExpired: string;
  maxAttempts: string;
  userDeleted: string;
  /** Fallbacks for an error that carries no message of its own. */
  somethingWentWrong: string;
  failedToSendCode: string;
  failedToVerifyCode: string;
  failedToResendCode: string;
  /** Signed in with the wrong kind of account. `{userType}`. */
  wrongPortal: string;
  userTypeImporter: string;
  userTypeProducer: string;
  /**
   * Overrides by `AuthError.code` for any code (including ones this package does not know). Wins over the fields above and over
   * the server's own message, which is English.
   */
  errors: Readonly<Record<string, string>>;
}

export const DEFAULT_LOGIN_FORM_COPY: LoginFormCopy = {
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
  errors: {},
};

/** Merge a host's partial copy over the English defaults (`errors` merges key by key). */
export function resolveLoginFormCopy(copy?: Partial<LoginFormCopy>): LoginFormCopy {
  return {
    ...DEFAULT_LOGIN_FORM_COPY,
    ...copy,
    errors: { ...DEFAULT_LOGIN_FORM_COPY.errors, ...copy?.errors },
  };
}

/**
 * Every user-visible string of the (deprecated) `RegisterForm`. Placeholders: `{email}` (accountCreatedDescription), `{role}`
 * (registerAsDescription: `roleImporter` / `roleProducer`).
 */
export interface RegisterFormCopy {
  accountCreatedHeading: string;
  accountCreatedDescription: string;
  goToLogin: string;
  heading: string;
  registerAsDescription: string;
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
  /** Overrides by `AuthError.code`, winning over the fields above and the server's English message. */
  errors: Readonly<Record<string, string>>;
}

export const DEFAULT_REGISTER_FORM_COPY: RegisterFormCopy = {
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
  errors: {},
};

export function resolveRegisterFormCopy(copy?: Partial<RegisterFormCopy>): RegisterFormCopy {
  return {
    ...DEFAULT_REGISTER_FORM_COPY,
    ...copy,
    errors: { ...DEFAULT_REGISTER_FORM_COPY.errors, ...copy?.errors },
  };
}
