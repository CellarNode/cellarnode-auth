"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { AuthApi } from "../types.js";
import { AuthError } from "../types.js";
import {
  DEFAULT_REGISTER_FORM_COPY as D,
  renderCopy,
  resolveRegisterFormCopy,
  type RegisterFormCopy,
} from "./copy.js";
import { Loader2 } from "lucide-react";

/**
 * @deprecated CEL-2087: `RegisterForm` registers directly, with no proof the
 * caller controls the submitted email. `/auth/register` will require
 * `registrationToken` on the public route once backend phase 3 deploys
 * (CEL-2087). From then on, this component's plain `register()` call fails
 * with `400 REGISTRATION_TOKEN_REQUIRED` for every consumer. Build a
 * confirm-first flow instead: `OtpConfirmationStep` (this package) to collect
 * and verify a 6-digit code via `POST /auth/registration/request-code` /
 * `verify-code`, then pass the resulting token as `RegisterInput.registrationToken`
 * to `authApi.register()`. For a worked reference implementation of the full
 * details → code → register sequence, see `cellarnode-importer-dashboard`'s
 * `src/routes/create-account.tsx` (on main); producer-dashboard PR #869 adds
 * the producer equivalent.
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
  /** Localized text for every user-visible string (CEL-2572); omitted fields keep their English defaults. */
  copy?: Partial<RegisterFormCopy>;
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
  copy,
}: RegisterFormProps) {
  const c = useMemo(() => resolveRegisterFormCopy(copy), [copy]);
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
        const known: Record<string, string> = {
          USER_ALREADY_EXISTS: c.userAlreadyExists,
          USER_DELETED: c.userDeleted,
          REGISTRATION_CLOSED: c.registrationClosed,
          INVITE_TOKEN_INVALID: c.inviteTokenInvalid,
        };
        const override = Object.hasOwn(c.errors, err.code) ? c.errors[err.code] : undefined;
        const named = Object.hasOwn(known, err.code) ? known[err.code] : undefined;
        // An unknown code shows the host's fallback when it supplied one (a default is never "supplied"), else the server's message.
        setError(override ?? named ?? copy?.registrationFailed ?? err.message);
      } else if (err instanceof TypeError && copy?.networkError) {
        setError(copy.networkError);
      } else if (copy?.registrationFailed) {
        setError(copy.registrationFailed);
      } else {
        setError(err instanceof Error ? err.message : c.registrationFailed);
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  if (success) {
    return (
      <RegisterCard>
        <div className="p-6 text-center">
          <h2 className="text-2xl font-semibold">{c.accountCreatedHeading}</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {renderCopy(c.accountCreatedDescription, { email }, D.accountCreatedDescription as string)}
          </p>
        </div>
        <div className="px-6 pb-6">
          <button
            type="button"
            onClick={onNavigateLogin}
            className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90 transition-colors"
          >
            {c.goToLogin}
          </button>
        </div>
      </RegisterCard>
    );
  }

  return (
    <RegisterCard>
      <div className="p-6 text-center">
        <h2 className="text-2xl font-semibold">{c.heading}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {renderCopy(
            c.registerAsDescription,
            { role: userType === "importer" ? c.roleImporter : c.roleProducer, userType },
            D.registerAsDescription as string,
          )}
        </p>
      </div>
      <div className="px-6 pb-6">
        <form onSubmit={handleSubmit} className="grid gap-4">
          <div className="grid gap-2">
            <label
              htmlFor="name"
              className="text-sm font-medium leading-none"
            >
              {c.fullName}
            </label>
            <input
              id="name"
              type="text"
              placeholder={c.fullNamePlaceholder}
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
              {c.email}
            </label>
            <input
              id="reg-email"
              type="email"
              placeholder={c.emailPlaceholder}
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
              {c.phone}
            </label>
            <input
              id="phone"
              type="tel"
              placeholder={c.phonePlaceholder}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={isSubmitting}
            className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90 transition-colors disabled:pointer-events-none disabled:opacity-50"
          >
            {isSubmitting && (
              <Loader2 className="mr-2 size-4 animate-spin" />
            )}
            {c.createAccount}
          </button>
          <button
            type="button"
            onClick={onNavigateLogin}
            className="inline-flex h-10 w-full items-center justify-center rounded-md text-sm font-medium hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            {c.alreadyHaveAccount}
          </button>
        </form>
      </div>
    </RegisterCard>
  );
}
