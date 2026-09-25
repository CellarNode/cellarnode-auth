"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import type { AuthApi } from "../types.js";
import { AuthError } from "../types.js";
import { Loader2 } from "lucide-react";

/**
 * @deprecated CEL-2087: `RegisterForm` registers directly, with no proof the
 * caller controls the submitted email — the backend's phase-3 confirm-first
 * requirement (`registrationToken`, required on the public route since
 * CEL-2087 phase 3) means this component's plain `register()` call now fails
 * with `400 REGISTRATION_TOKEN_REQUIRED` for every consumer. Build a
 * confirm-first flow instead: `OtpConfirmationStep` (this package) to collect
 * and verify a 6-digit code via `POST /auth/registration/request-code` /
 * `verify-code`, then pass the resulting token as `RegisterInput.registrationToken`
 * to `authApi.register()`. See `producer-dashboard`'s and
 * `cellarnode-importer-dashboard`'s `src/routes/create-account.tsx` for a
 * worked reference implementation of the full details → code → register
 * sequence.
 */
export interface RegisterFormProps {
  userType: "importer" | "producer";
  onRegistered: () => void;
  onNavigateLogin: () => void;
  authApi: AuthApi;
  /**
   * CEL-1814: org-invite token from the invite link. Sent with the register
   * call; while the surface's registration switch is closed (backend default)
   * a valid token is the only way through.
   */
  inviteToken?: string;
}

function RegisterCard({ children }: { readonly children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card text-card-foreground shadow-sm">
      {children}
    </div>
  );
}

/** @deprecated See {@link RegisterFormProps} for why and what to use instead. */
export function RegisterForm({
  userType,
  onRegistered,
  onNavigateLogin,
  authApi,
  inviteToken,
}: RegisterFormProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setIsSubmitting(true);

    try {
      await authApi.register({
        name,
        email,
        phone: phone || undefined,
        userType,
        inviteToken: inviteToken || undefined,
      });
      setSuccess(true);
      onRegistered();
    } catch (err) {
      if (err instanceof AuthError) {
        if (err.code === "USER_ALREADY_EXISTS") {
          setError(
            "An account with this email already exists. Please log in instead.",
          );
        } else if (err.code === "USER_DELETED") {
          setError(
            "This account has been deactivated. Please contact support.",
          );
        } else if (err.code === "REGISTRATION_CLOSED") {
          // CEL-1814/1815: the surface's self-registration switch is closed —
          // an org invitation is required.
          setError(
            "Registration is invite-only. Please use the sign-up link from your invite email.",
          );
        } else if (err.code === "INVITE_TOKEN_INVALID") {
          setError(
            "Your invitation is invalid, expired, or was sent to a different email address. Ask your organisation admin to resend it.",
          );
        } else {
          setError(err.message);
        }
      } else {
        setError(
          err instanceof Error ? err.message : "Registration failed",
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  if (success) {
    return (
      <RegisterCard>
        <div className="p-6 text-center">
          <h2 className="text-2xl font-semibold">Account created</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Your account has been created. Log in with a one-time code sent
            to {email} to get started.
          </p>
        </div>
        <div className="px-6 pb-6">
          <button
            type="button"
            onClick={onNavigateLogin}
            className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90 transition-colors"
          >
            Go to Login
          </button>
        </div>
      </RegisterCard>
    );
  }

  return (
    <RegisterCard>
      <div className="p-6 text-center">
        <h2 className="text-2xl font-semibold">Create an account</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Register as {userType === "importer" ? "an importer" : "a producer"}{" "}
          to get started
        </p>
      </div>
      <div className="px-6 pb-6">
        <form onSubmit={handleSubmit} className="grid gap-4">
          <div className="grid gap-2">
            <label
              htmlFor="name"
              className="text-sm font-medium leading-none"
            >
              Full name
            </label>
            <input
              id="name"
              type="text"
              placeholder="Jane Doe"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>
          <div className="grid gap-2">
            <label
              htmlFor="reg-email"
              className="text-sm font-medium leading-none"
            >
              Email
            </label>
            <input
              id="reg-email"
              type="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>
          <div className="grid gap-2">
            <label
              htmlFor="phone"
              className="text-sm font-medium leading-none"
            >
              Phone (optional)
            </label>
            <input
              id="phone"
              type="tel"
              placeholder="+1 555 123 4567"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <button
            type="submit"
            disabled={isSubmitting}
            className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90 transition-colors disabled:pointer-events-none disabled:opacity-50"
          >
            {isSubmitting && (
              <Loader2 className="mr-2 size-4 animate-spin" />
            )}
            Create account
          </button>
          <button
            type="button"
            onClick={onNavigateLogin}
            className="inline-flex h-10 w-full items-center justify-center rounded-md text-sm font-medium hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            Already have an account? Log in
          </button>
        </form>
      </div>
    </RegisterCard>
  );
}
