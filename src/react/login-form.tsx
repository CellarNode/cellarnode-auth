"use client";

import React, { Suspense, useEffect, useState } from "react";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Clock3,
  Loader2,
} from "lucide-react";
import { clsx } from "clsx";
import type { AuthApi, AuthStore } from "../types.js";
import { AuthError } from "../types.js";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "./input-otp-slots.js";

const LazySquircleShift = React.lazy(() =>
  import("./squircle-shift.js").then((m) => ({ default: m.SquircleShift })),
);

export interface LoginFormProps {
  userType: "importer" | "producer";
  brandName: string;
  brandDescription?: string;
  authApi: AuthApi;
  authStore: AuthStore;
  onLoginSuccess: () => void;
  onNavigateRegister?: () => void;
  logoSrc?: string;
  inviteMode?: boolean;
  initialEmail?: string;
  theme?: "light" | "dark";
  onResendSuccess?: () => void;
  /** Footer content shown on the email step. Accepts string or ReactNode. Defaults to "Need an account? Contact your CellarNode representative." */
  footerText?: React.ReactNode;
  /** When true, footer shows a clickable register link (uses onNavigateRegister). When false, shows static footerText. Default: false */
  showRegisterInFooter?: boolean;
  /** Optional "Back" button handler shown in top-right corner */
  onBack?: () => void;
  /** Error callback — receives structured error info for external handling (e.g. toast notifications). When provided, only a brief inline hint shows near the input; the full message goes through this callback. */
  onError?: (error: {
    code: string;
    message: string;
    remainingAttempts?: number;
  }) => void;
  /** Custom content shown below the input when the email is not found (USER_NOT_FOUND). Replaces the default "Create an account instead" link. Pass ReactNode for full control. */
  notFoundContent?: React.ReactNode;
}

type Step = "email" | "otp";

function formatCountdown(target: string | null, fallback = "10:00") {
  if (!target) return fallback;
  const diff = Math.max(0, new Date(target).getTime() - Date.now());
  const minutes = String(Math.floor(diff / 60_000)).padStart(2, "0");
  const seconds = String(Math.floor((diff % 60_000) / 1000)).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

const ERROR_MESSAGES: Record<string, string> = {
  USER_NOT_FOUND: "No account found with this email.",
  OTP_RATE_LIMIT: "Too many code requests. Please wait before trying again.",
  OTP_NOT_FOUND: "Code expired. Please request a new one.",
  OTP_MAX_ATTEMPTS: "Too many failed attempts. Please request a new code.",
  USER_DELETED: "This account has been deactivated. Contact support.",
};

export function LoginForm({
  userType,
  brandName,
  authApi,
  authStore,
  onLoginSuccess,
  onNavigateRegister,
  logoSrc,
  inviteMode = false,
  initialEmail = "",
  theme = "light",
  onResendSuccess,
  footerText = "Need an account? Contact your CellarNode representative.",
  showRegisterInFooter = false,
  onBack,
  onError,
  notFoundContent,
}: LoginFormProps) {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [isNotFound, setIsNotFound] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [resendAvailableAt, setResendAvailableAt] = useState<string | null>(null);
  const [countdown, setCountdown] = useState("10:00");
  const [resendCountdown, setResendCountdown] = useState("01:00");

  useEffect(() => {
    if (!expiresAt) return;

    setCountdown(formatCountdown(expiresAt));
    const interval = window.setInterval(() => {
      setCountdown(formatCountdown(expiresAt));
    }, 1000);

    return () => window.clearInterval(interval);
  }, [expiresAt]);

  useEffect(() => {
    if (!resendAvailableAt) return;

    setResendCountdown(formatCountdown(resendAvailableAt, "01:00"));
    const interval = window.setInterval(() => {
      setResendCountdown(formatCountdown(resendAvailableAt, "01:00"));
    }, 1000);

    return () => window.clearInterval(interval);
  }, [resendAvailableAt]);

  const canResend = resendAvailableAt
    ? new Date(resendAvailableAt).getTime() <= Date.now()
    : false;
  const stepIndex = step === "email" ? 0 : 1;
  const normalizedEmail = email.trim();

  function handleAuthError(err: unknown, fallbackMessage: string) {
    if (err instanceof AuthError) {
      const msg =
        err.code === "OTP_INVALID"
          ? `Invalid code. ${err.remainingAttempts ?? 0} attempt(s) remaining.`
          : ERROR_MESSAGES[err.code] ?? err.message ?? "Something went wrong";

      // Side effects for specific error codes
      if (err.code === "USER_NOT_FOUND") {
        setIsNotFound(true);
      }
      if (err.code === "OTP_NOT_FOUND" || err.code === "OTP_MAX_ATTEMPTS") {
        setExpiresAt(new Date(0).toISOString());
        setResendAvailableAt(new Date(0).toISOString());
      }

      // Route error to callback if provided
      if (onError) {
        onError({
          code: err.code,
          message: msg,
          remainingAttempts: err.remainingAttempts,
        });
        // Still show brief inline hint for context
        setError(msg);
      } else {
        setError(msg);
      }
    } else {
      const msg = err instanceof Error ? err.message : fallbackMessage;
      if (onError) {
        onError({ code: "UNKNOWN", message: msg });
      }
      setError(msg);
    }
  }

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setIsNotFound(false);
    setIsSubmitting(true);

    try {
      const response = await authApi.requestOtp(normalizedEmail);
      setExpiresAt(response.expiresAt);
      setResendAvailableAt(response.resendAvailableAt);
      setStep("otp");
      setCode("");
    } catch (err) {
      handleAuthError(err, "Failed to send code");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleOtpSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setIsNotFound(false);
    setIsSubmitting(true);

    try {
      const result = await authApi.verifyOtp(normalizedEmail, code);

      if (result.user.userType !== userType) {
        const msg = `This portal is for ${userType} accounts only.`;
        setError(msg);
        if (onError) onError({ code: "USER_TYPE_MISMATCH", message: msg });
        authStore.clearAccessToken();
        return;
      }

      authStore.setAccessToken(result.accessToken, result.expiresIn);
      onLoginSuccess();
    } catch (err) {
      handleAuthError(err, "Invalid code");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleResend() {
    setError("");
    setIsNotFound(false);
    setIsSubmitting(true);

    try {
      const response = await authApi.requestOtp(normalizedEmail);
      setExpiresAt(response.expiresAt);
      setResendAvailableAt(response.resendAvailableAt);
      setCode("");
      onResendSuccess?.();
    } catch (err) {
      handleAuthError(err, "Failed to resend code");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      {/* Left: Form Panel */}
      <div className="flex flex-col px-6 py-6 sm:px-10 sm:py-8 lg:px-14 lg:py-10">
        {/* Top bar */}
        <div className="flex items-center justify-between gap-4">
          <div className="inline-flex items-center gap-3">
            {logoSrc ? (
              <img
                src={logoSrc}
                alt={brandName}
                width={36}
                height={36}
                className="size-9 rounded-full"
              />
            ) : (
              <div className="flex size-9 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
                {brandName.charAt(0)}
              </div>
            )}
            <span className="font-semibold text-foreground">{brandName}</span>
          </div>
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" />
              Back
            </button>
          )}
        </div>

        {/* Centered form area */}
        <div className="flex flex-1 items-center justify-center py-12">
          <div className="w-full max-w-sm">
            {/* Step indicator dots */}
            <div className="mb-8 flex items-center gap-2.5">
              {[0, 1].map((i) => (
                <div
                  key={i}
                  className={clsx(
                    "size-2.5 rounded-full transition-colors",
                    stepIndex >= i ? "bg-primary" : "bg-border",
                  )}
                />
              ))}
            </div>

            {/* Invite context banner */}
            {inviteMode && step === "email" && (
              <div className="mb-4 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 text-sm/6 text-foreground">
                Signing in to accept your organization invitation.
              </div>
            )}

            {/* Heading */}
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              {step === "email" ? "Sign in to your account" : "Check your email"}
            </h1>
            <p className="mt-2 text-sm/6 text-muted-foreground">
              {step === "email"
                ? "Enter your work email to receive a one-time access code."
                : `We sent a 6-digit code to ${normalizedEmail}.`}
            </p>

            {/* Forms */}
            <div className="mt-8">
              {step === "email" ? (
                <form onSubmit={handleEmailSubmit} className="grid gap-5">
                  <div className="grid gap-2">
                    <label
                      htmlFor="email"
                      className="text-sm font-medium leading-none"
                    >
                      Email address
                    </label>
                    <input
                      id="email"
                      type="email"
                      placeholder="you@company.com"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      required
                      autoFocus
                      aria-invalid={!!error || undefined}
                      className={clsx(
                        "flex h-10 w-full rounded-md border bg-background px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 transition-colors",
                        error
                          ? "border-destructive focus-visible:ring-destructive/30 focus-visible:border-destructive"
                          : "border-input focus-visible:ring-ring/50 focus-visible:border-ring",
                      )}
                    />
                    {error && !onError && (
                      <div className="flex items-start gap-2 text-sm text-destructive">
                        <AlertCircle className="size-4 shrink-0 mt-0.5" />
                        <span>{error}</span>
                      </div>
                    )}
                    {isNotFound && notFoundContent && (
                      <div className="mt-1 text-sm text-muted-foreground">
                        {notFoundContent}
                      </div>
                    )}
                  </div>

                  <button
                    type="submit"
                    className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
                    disabled={isSubmitting || !normalizedEmail}
                  >
                    {isSubmitting ? (
                      <Loader2 className="mr-2 size-4 animate-spin" />
                    ) : (
                      <ArrowRight className="mr-2 size-4" />
                    )}
                    Continue
                  </button>
                </form>
              ) : (
                <form id="otp-form" onSubmit={handleOtpSubmit} className="grid gap-5">
                  {/* Countdown badge */}
                  <div className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border bg-muted/50 px-3 py-1 text-xs font-medium text-muted-foreground">
                    <Clock3 className="size-3" />
                    Expires in {countdown}
                  </div>

                  <div className="grid gap-2">
                    <InputOTP
                      id="otp"
                      value={code}
                      onChange={(value) => setCode(value)}
                      onComplete={() => {
                        const form = document.getElementById(
                          "otp-form",
                        ) as HTMLFormElement | null;
                        form?.requestSubmit();
                      }}
                      maxLength={6}
                      pattern={REGEXP_ONLY_DIGITS}
                      autoFocus
                      data-invalid={!!error || undefined}
                      containerClassName="justify-center"
                    >
                      <InputOTPGroup>
                        <InputOTPSlot index={0} />
                        <InputOTPSlot index={1} />
                        <InputOTPSlot index={2} />
                      </InputOTPGroup>
                      <InputOTPSeparator />
                      <InputOTPGroup>
                        <InputOTPSlot index={3} />
                        <InputOTPSlot index={4} />
                        <InputOTPSlot index={5} />
                      </InputOTPGroup>
                    </InputOTP>
                    {error && !onError && (
                      <div className="flex items-center justify-center gap-2 text-sm text-destructive">
                        <AlertCircle className="size-4 shrink-0" />
                        <span>{error}</span>
                      </div>
                    )}
                  </div>

                  <button
                    type="submit"
                    className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
                    disabled={isSubmitting || code.length !== 6}
                  >
                    {isSubmitting ? (
                      <Loader2 className="mr-2 size-4 animate-spin" />
                    ) : (
                      <CheckCircle2 className="mr-2 size-4" />
                    )}
                    Verify
                  </button>

                  <div className="flex items-center justify-between text-sm">
                    <button
                      type="button"
                      className="text-muted-foreground transition-colors hover:text-foreground"
                      onClick={() => {
                        setStep("email");
                        setCode("");
                        setError("");
                        setIsNotFound(false);
                      }}
                    >
                      <span className="inline-flex items-center gap-1">
                        <ArrowLeft className="size-3.5" />
                        Change email
                      </span>
                    </button>
                    <button
                      type="button"
                      className="text-primary transition-colors hover:text-primary/80 disabled:text-muted-foreground/50"
                      onClick={handleResend}
                      disabled={isSubmitting || !canResend}
                    >
                      {canResend ? "Resend code" : `Resend in ${resendCountdown}`}
                    </button>
                  </div>
                </form>
              )}
            </div>

            {/* Footer — only on email step */}
            {step === "email" && (
              <p className="mt-8 text-center text-sm text-muted-foreground">
                {showRegisterInFooter && onNavigateRegister ? (
                  <>
                    Need an account?{" "}
                    <button
                      type="button"
                      onClick={onNavigateRegister}
                      className="text-primary transition-colors hover:text-primary/80"
                    >
                      Register here
                    </button>
                  </>
                ) : (
                  footerText
                )}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Right: SquircleShift (desktop only) */}
      <div className="hidden lg:block">
        <Suspense fallback={<div className="size-full bg-muted" />}>
          <LazySquircleShift className="size-full" theme={theme} />
        </Suspense>
      </div>
    </div>
  );
}
