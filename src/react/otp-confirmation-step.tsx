"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
}

/**
 * Localizable copy for {@link OtpConfirmationStep}. Every field is optional
 * with an English default, so a consumer can override only what it needs
 * (mirrors {@link UnauthorizedPageLabels}'s pattern). Pass fully-translated
 * nodes (e.g. i18next `t()` results or `<Trans>`) — this component owns no
 * translation strings itself; each dashboard keeps its own locale files.
 */
export interface OtpConfirmationLabels {
  /** Shown above the code input. Default: "We sent a {codeLength}-digit code to {email}." */
  description?: ReactNode;
  /** Default "Sending code…" */
  sendingLabel?: string;
  /** Default "Verifying…" */
  verifyingLabel?: string;
  /** Default "Resend code" */
  resendLabel?: string;
  /** Default `Resend in ${seconds}s` */
  resendInLabel?: (seconds: number) => ReactNode;
  /** aria-label on the code input. Default "Verification code" */
  codeInputAriaLabel?: string;
  errorMessages?: {
    /** `OTP_INVALID`. Receives `remainingAttempts` when the server reports it. */
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
   * cannot send two codes for the same address (CEL-2087).
   */
  autoRequestOnMount?: boolean;
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

type Status = "sending" | "sent" | "verifying";

export function OtpConfirmationStep({
  email,
  codeLength = DEFAULT_CODE_LENGTH,
  autoRequestOnMount = true,
  onRequestCode,
  onVerifyCode,
  onVerified,
  labels,
  mapError = defaultMapError,
}: OtpConfirmationStepProps) {
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<Status>("sending");
  const [error, setError] = useState<OtpConfirmationError | null>(null);
  const [resendAvailableAt, setResendAvailableAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [resending, setResending] = useState(false);

  // "Latest ref" pattern: the mount effect below reads through this ref
  // rather than depending on `onRequestCode` directly, so a parent re-render
  // that hands in a new (but behaviorally identical) callback can never
  // re-trigger the one-flight mount request.
  const onRequestCodeRef = useRef(onRequestCode);
  useEffect(() => {
    onRequestCodeRef.current = onRequestCode;
  }, [onRequestCode]);

  const requestCode = useCallback(
    async (isResend: boolean) => {
      setError(null);
      if (isResend) setResending(true);
      else setStatus("sending");
      try {
        const timings = await onRequestCodeRef.current(isResend);
        setResendAvailableAt(Date.parse(timings.resendAvailableAt));
        setNow(Date.now());
        setStatus("sent");
        if (isResend) setCode("");
      } catch (err) {
        setStatus("sent");
        setError(mapError(err));
      } finally {
        if (isResend) setResending(false);
      }
    },
    [mapError],
  );

  // One-flight guard on mount, keyed by `email` — the ref survives React 18
  // StrictMode's dev-only mount→unmount→mount double-invoke (same component
  // instance), so it fires exactly once per distinct email even there. Fixes
  // the importer StrictMode double-request bug generically for every
  // consumer of this component (CEL-2087).
  const requestedForEmailRef = useRef<string | null>(null);
  useEffect(() => {
    if (!autoRequestOnMount) return;
    if (requestedForEmailRef.current === email) return;
    requestedForEmailRef.current = email;
    void requestCode(false);
  }, [email, autoRequestOnMount, requestCode]);

  // Tick once per second only while a resend cooldown is active.
  useEffect(() => {
    if (!resendAvailableAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [resendAvailableAt]);

  const verify = useCallback(
    async (value: string) => {
      setError(null);
      setStatus("verifying");
      try {
        await onVerifyCode(value);
        onVerified?.();
      } catch (err) {
        setStatus("sent");
        setCode("");
        setError(mapError(err));
      }
    },
    [onVerifyCode, onVerified, mapError],
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

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {labels?.description ?? `We sent a ${codeLength}-digit code to ${email}.`}
      </p>
      <InputOTP
        maxLength={codeLength}
        value={code}
        onChange={handleCodeChange}
        disabled={status === "verifying"}
        autoFocus
        autoComplete="one-time-code"
        inputMode="numeric"
        data-invalid={Boolean(error) || undefined}
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
        {status === "verifying" && (labels?.verifyingLabel ?? "Verifying…")}
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {resolveErrorMessage(error, labels)}
        </p>
      )}
      <button
        type="button"
        disabled={!canResend || resending || status === "verifying"}
        onClick={() => void requestCode(true)}
        className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-primary transition-colors hover:text-primary/80 disabled:text-muted-foreground/60"
      >
        {resending
          ? (labels?.sendingLabel ?? "Sending…")
          : canResend
            ? (labels?.resendLabel ?? "Resend code")
            : (labels?.resendInLabel?.(resendInSeconds) ?? `Resend in ${resendInSeconds}s`)}
      </button>
    </div>
  );
}
