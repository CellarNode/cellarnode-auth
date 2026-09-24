"use client";

import { REGEXP_ONLY_DIGITS } from "input-otp";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "./input-otp-slots.js";

/** Normalized shape of a failed request/verify call, for copy mapping. */
export interface OtpConfirmationError {
  code: string;
  remainingAttempts?: number;
}

export interface OtpConfirmationTimings {
  expiresAt: string;
  resendAvailableAt: string;
  /**
   * Server-computed relative seconds (backend #863, CEL-2087 review item 8).
   * Additive/optional — when present, preferred over the absolute timestamps
   * because they're immune to client/server clock skew (anchored to the
   * moment THIS client received the response, not the server's clock).
   */
  resendAfterSeconds?: number;
  expiresInSeconds?: number;
}

/**
 * Localizable copy for {@link OtpConfirmationStep}. Every field is optional
 * with an English default, so a consumer can override only what it needs
 * (mirrors {@link UnauthorizedPageLabels}'s pattern). Pass fully-translated
 * nodes (e.g. i18next `t()` results or `<Trans>`) — this component owns no
 * translation strings itself; each dashboard keeps its own locale files.
 */
export interface OtpConfirmationLabels {
  /**
   * Shown above the code input. Default varies by whether a code has
   * actually been sent yet: "We'll send a {codeLength}-digit code to
   * {email}." before sending (the idle state), "We sent a {codeLength}-digit
   * code to {email}." once sent (CEL-1810 — don't claim a code was sent
   * before it was). Overriding this replaces BOTH defaults with one fixed
   * string; use `descriptionIdle` if you need the two to differ.
   */
  description?: ReactNode;
  /** Overrides only the idle (not-yet-sent) description; falls back to `description`, then the default above. */
  descriptionIdle?: ReactNode;
  /** Shown on the idle state's call-to-action button. Default "Send code" */
  sendCodeLabel?: string;
  /** Default "Sending code…" */
  sendingLabel?: string;
  /** Default "Verifying…" */
  verifyingLabel?: string;
  /** Shown once the client-side countdown says the code has expired (before any verify attempt). Default "This code has expired. Request a new one." */
  codeExpiredLabel?: ReactNode;
  /** Default "Resend code" */
  resendLabel?: string;
  /** Shown on the resend button while a resend is in flight. Default "Resending…" (distinct from `sendingLabel`'s "Sending code…" status line). */
  resendingLabel?: string;
  /** Default `Resend in ${seconds}s` */
  resendInLabel?: (seconds: number) => ReactNode;
  /** Announced via `aria-live="polite"` after a successful resend. Default "A new code has been sent." */
  resendAnnouncementLabel?: string;
  /** aria-label on the code input. Default "Verification code" */
  codeInputAriaLabel?: string;
  errorMessages?: {
    /**
     * `OTP_INVALID`. Receives `remainingAttempts` when the server reports
     * it. Default English pluralizes "attempt(s)" via
     * `remainingAttempts === 1 ? "" : "s"` — override for other locales.
     */
    invalid?: (remainingAttempts?: number) => ReactNode;
    /** `OTP_MAX_ATTEMPTS` */
    maxAttempts?: ReactNode;
    /** `OTP_NOT_FOUND` — covers both an expired code and a reused/already-consumed one. */
    expired?: ReactNode;
    /** `OTP_RATE_LIMIT` (429 on request/resend) */
    rateLimit?: ReactNode;
    /** Any other/unrecognized error code. */
    generic?: ReactNode;
  };
}

export interface OtpConfirmationStepProps {
  /** Address the code was (or will be) sent to. Display/keying only — not editable here. */
  email: string;
  /** Default 6. */
  codeLength?: number;
  /**
   * Fire `onRequestCode(false)` once when this step mounts. Default true.
   * The mount request is one-flight-guarded internally (keyed by `email`) so
   * React 18 StrictMode's dev-only double-invoke, or a parent re-render,
   * cannot send two codes for the same address (CEL-2087). Has no effect
   * when `initialTimings` is provided — a code already sent before this
   * step mounted is never re-requested regardless of this prop.
   */
  autoRequestOnMount?: boolean;
  /**
   * Timings for a code already sent BEFORE this step mounted (CEL-2087 —
   * e.g. producer's invite-registration flow sends the code earlier in the
   * journey, then hands off to this step for confirmation only). When
   * provided, the component starts directly in the "sent" state using these
   * timings instead of auto-requesting or sitting idle; pair with
   * `autoRequestOnMount={false}`.
   */
  initialTimings?: OtpConfirmationTimings;
  /**
   * Request (or resend, when `isResend`) a code. Must resolve with the
   * server's REAL timings — this is what makes the cooldown enforced
   * server-side (CEL-2087) visible as an accurate countdown here. A
   * cooldown-blocked resend returns the same shape as a fresh send (no
   * distinct error), so this component never renders a "still cooling down"
   * error — only the countdown reflects it.
   */
  onRequestCode: (isResend: boolean) => Promise<OtpConfirmationTimings>;
  /** Resolve = verified. Throw on failure (see `mapError`). */
  onVerifyCode: (code: string) => Promise<void>;
  /** Fired after `onVerifyCode` resolves without throwing. */
  onVerified?: () => void;
  labels?: OtpConfirmationLabels;
  /**
   * Normalizes a thrown request/verify error into `{ code, remainingAttempts? }`.
   * Default: passes through an object already shaped that way (e.g. the
   * backend's typed `OTP_*` error codes), else reports a generic error.
   */
  mapError?: (err: unknown) => OtpConfirmationError;
}

const DEFAULT_CODE_LENGTH = 6;

function defaultMapError(err: unknown): OtpConfirmationError {
  if (err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string") {
    const remainingAttempts =
      "remainingAttempts" in err && typeof (err as { remainingAttempts: unknown }).remainingAttempts === "number"
        ? (err as { remainingAttempts: number }).remainingAttempts
        : undefined;
    return { code: (err as { code: string }).code, remainingAttempts };
  }
  return { code: "UNKNOWN" };
}

function resolveErrorMessage(error: OtpConfirmationError, labels: OtpConfirmationLabels | undefined): ReactNode {
  switch (error.code) {
    case "OTP_INVALID":
      return (
        labels?.errorMessages?.invalid?.(error.remainingAttempts) ??
        (typeof error.remainingAttempts === "number"
          ? `That code didn't match. ${error.remainingAttempts} attempt${error.remainingAttempts === 1 ? "" : "s"} left.`
          : "That code didn't match. Please try again.")
      );
    case "OTP_MAX_ATTEMPTS":
      return labels?.errorMessages?.maxAttempts ?? "Too many incorrect attempts. Request a new code.";
    case "OTP_NOT_FOUND":
      return labels?.errorMessages?.expired ?? "That code has expired or was already used. Request a new one.";
    case "OTP_RATE_LIMIT":
      return labels?.errorMessages?.rateLimit ?? "Too many requests. Please wait a moment and try again.";
    default:
      return labels?.errorMessages?.generic ?? "Something went wrong. Please try again.";
  }
}

/**
 * Resolve a target instant, preferring the server's relative seconds
 * (anchored to `receivedAt`, this client's OWN receipt time) over the
 * absolute timestamp, which is subject to client/server clock skew
 * (CEL-2087 P2 review item 4). A missing/malformed absolute timestamp
 * (unparseable, `NaN`) falls back to `receivedAt` itself — i.e. "available
 * right now" — rather than leaving the countdown permanently stuck
 * (CEL-2087 P1 review item 1).
 */
function resolveTimestamp(relativeSeconds: number | undefined, absoluteIso: string, receivedAt: number): number {
  if (typeof relativeSeconds === "number" && Number.isFinite(relativeSeconds)) {
    return receivedAt + Math.max(0, relativeSeconds) * 1000;
  }
  const parsed = Date.parse(absoluteIso);
  return Number.isNaN(parsed) ? receivedAt : parsed;
}

type Status = "idle" | "sending" | "sent" | "verifying";

export function OtpConfirmationStep({
  email,
  codeLength = DEFAULT_CODE_LENGTH,
  autoRequestOnMount = true,
  initialTimings,
  onRequestCode,
  onVerifyCode,
  onVerified,
  labels,
  mapError = defaultMapError,
}: OtpConfirmationStepProps) {
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<Status>(() => {
    if (initialTimings) return "sent";
    return autoRequestOnMount ? "sending" : "idle";
  });
  const [error, setError] = useState<OtpConfirmationError | null>(null);
  const [resendAvailableAt, setResendAvailableAt] = useState<number | null>(() =>
    initialTimings
      ? resolveTimestamp(initialTimings.resendAfterSeconds, initialTimings.resendAvailableAt, Date.now())
      : null,
  );
  const [expiresAt, setExpiresAt] = useState<number | null>(() =>
    initialTimings ? resolveTimestamp(initialTimings.expiresInSeconds, initialTimings.expiresAt, Date.now()) : null,
  );
  const [now, setNow] = useState(() => Date.now());
  const [resending, setResending] = useState(false);
  const [resendAnnouncement, setResendAnnouncement] = useState<string | null>(null);

  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  // "Latest ref" pattern: the mount effect below reads through this ref
  // rather than depending on `onRequestCode` directly, so a parent re-render
  // that hands in a new (but behaviorally identical) callback can never
  // re-trigger the one-flight mount request.
  const onRequestCodeRef = useRef(onRequestCode);
  useEffect(() => {
    onRequestCodeRef.current = onRequestCode;
  }, [onRequestCode]);

  const labelsRef = useRef(labels);
  useEffect(() => {
    labelsRef.current = labels;
  }, [labels]);

  // CEL-2087 P3 review item 12: the CURRENT email, read at response time to
  // detect (and ignore) a response that arrives for a PREVIOUS email — e.g.
  // the parent swaps `email` mid-request. `requestCode`/`verify` capture the
  // email they were called FOR and compare against this ref once their
  // promise settles.
  const emailRef = useRef(email);
  useEffect(() => {
    emailRef.current = email;
  }, [email]);

  const requestCode = useCallback(
    async (isResend: boolean) => {
      const requestEmail = email;
      setError(null);
      setResendAnnouncement(null);
      if (isResend) setResending(true);
      else setStatus("sending");
      try {
        const timings = await onRequestCodeRef.current(isResend);
        if (requestEmail !== emailRef.current) return; // stale — email changed mid-flight
        const receivedAt = Date.now();
        setResendAvailableAt(resolveTimestamp(timings.resendAfterSeconds, timings.resendAvailableAt, receivedAt));
        setExpiresAt(resolveTimestamp(timings.expiresInSeconds, timings.expiresAt, receivedAt));
        setNow(receivedAt);
        // Never clobber an in-flight verify: a resend completing WHILE the
        // user is being verified must not flip status back to "sent"
        // mid-verify and re-enable the input (CEL-2087 P3 review item 11).
        setStatus((prev) => (prev === "verifying" ? prev : "sent"));
        if (isResend) {
          setCode("");
          setResendAnnouncement(labelsRef.current?.resendAnnouncementLabel ?? "A new code has been sent.");
        }
      } catch (err) {
        if (requestEmail !== emailRef.current) return;
        setStatus((prev) => (prev === "verifying" ? prev : "sent"));
        setError(mapError(err));
        // A failed request — including the very first, mount-triggered one —
        // must not leave resend permanently disabled (CEL-2087 P1 review
        // item 1): make it available now, but don't shorten an ALREADY
        // active cooldown from a prior successful send.
        setResendAvailableAt((prev) => prev ?? Date.now());
        setNow(Date.now());
      } finally {
        if (requestEmail === emailRef.current && isResend) setResending(false);
      }
    },
    [email, mapError],
  );

  // One-flight guard on mount, keyed by `email` — the ref survives React 18
  // StrictMode's dev-only mount→unmount→mount double-invoke (same component
  // instance), so it fires exactly once per distinct email even there. Fixes
  // the importer StrictMode double-request bug generically for every
  // consumer of this component (CEL-2087). Skipped entirely when
  // `initialTimings` is provided (a code was already sent before mount).
  const requestedForEmailRef = useRef<string | null>(null);
  useEffect(() => {
    if (!autoRequestOnMount || initialTimings) return;
    if (requestedForEmailRef.current === email) return;
    requestedForEmailRef.current = email;
    void requestCode(false);
  }, [email, autoRequestOnMount, initialTimings, requestCode]);

  // Tick once per second while a resend cooldown or the expiry countdown is
  // active; self-clears once BOTH targets have passed instead of ticking
  // forever (CEL-2087 P3 review item 10).
  useEffect(() => {
    if (resendAvailableAt === null && expiresAt === null) return;
    const id = setInterval(() => {
      const tickNow = Date.now();
      const stillCounting =
        (resendAvailableAt !== null && tickNow < resendAvailableAt) ||
        (expiresAt !== null && tickNow < expiresAt);
      setNow(tickNow);
      if (!stillCounting) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [resendAvailableAt, expiresAt]);

  const verify = useCallback(
    async (value: string) => {
      const requestEmail = email;
      setError(null);
      setStatus("verifying");
      try {
        await onVerifyCode(value);
        if (requestEmail !== emailRef.current) return;
        onVerified?.();
      } catch (err) {
        if (requestEmail !== emailRef.current) return;
        setStatus("sent");
        setCode("");
        setError(mapError(err));
        // Restore focus after a failed verify — the input is `readOnly`
        // (not `disabled`) precisely so it stays focusable (CEL-2087 P2
        // review item 6).
        inputRef.current?.focus();
      }
    },
    [email, onVerifyCode, onVerified, mapError],
  );

  const handleCodeChange = useCallback(
    (value: string) => {
      setCode(value);
      if (value.length === codeLength && status !== "verifying") void verify(value);
    },
    [codeLength, status, verify],
  );

  const canResend = resendAvailableAt !== null && now >= resendAvailableAt;
  const resendInSeconds = resendAvailableAt ? Math.max(0, Math.ceil((resendAvailableAt - now) / 1000)) : 0;
  const isVerifying = status === "verifying";
  const isIdle = status === "idle";
  const isExpired = expiresAt !== null && now >= expiresAt;

  const defaultDescription = isIdle
    ? `We'll send a ${codeLength}-digit code to ${email}.`
    : `We sent a ${codeLength}-digit code to ${email}.`;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {isIdle ? (labels?.descriptionIdle ?? labels?.description ?? defaultDescription) : (labels?.description ?? defaultDescription)}
      </p>
      {isIdle ? (
        <button
          type="button"
          onClick={() => void requestCode(false)}
          className="inline-flex h-10 items-center justify-center self-start rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90"
        >
          {labels?.sendCodeLabel ?? "Send code"}
        </button>
      ) : (
        <>
          <InputOTP
            ref={inputRef}
            maxLength={codeLength}
            value={code}
            onChange={handleCodeChange}
            readOnly={isVerifying}
            autoFocus
            autoComplete="one-time-code"
            inputMode="numeric"
            pattern={REGEXP_ONLY_DIGITS}
            data-invalid={Boolean(error) || undefined}
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={error ? errorId : undefined}
            aria-busy={isVerifying || undefined}
            aria-label={labels?.codeInputAriaLabel ?? "Verification code"}
          >
            <InputOTPGroup>
              {Array.from({ length: codeLength }, (_, i) => (
                <InputOTPSlot key={i} index={i} />
              ))}
            </InputOTPGroup>
          </InputOTP>
          <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
            {status === "sending" && (labels?.sendingLabel ?? "Sending code…")}
            {isVerifying && (labels?.verifyingLabel ?? "Verifying…")}
            {status === "sent" &&
              isExpired &&
              !error &&
              (labels?.codeExpiredLabel ?? "This code has expired. Request a new one.")}
          </p>
          {error && (
            <p id={errorId} role="alert" className="text-sm text-destructive">
              {resolveErrorMessage(error, labels)}
            </p>
          )}
          <button
            type="button"
            disabled={!canResend || resending || isVerifying}
            onClick={() => void requestCode(true)}
            className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-primary transition-colors hover:text-primary/80 disabled:text-muted-foreground/60"
          >
            {resending
              ? (labels?.resendingLabel ?? "Resending…")
              : canResend
                ? (labels?.resendLabel ?? "Resend code")
                : (labels?.resendInLabel?.(resendInSeconds) ?? `Resend in ${resendInSeconds}s`)}
          </button>
          {/* Screen-reader-only: announces a successful resend (CEL-2087 P2 review item 6). */}
          <p aria-live="polite" className="sr-only" data-testid="resend-announcement">
            {resendAnnouncement}
          </p>
        </>
      )}
    </div>
  );
}
