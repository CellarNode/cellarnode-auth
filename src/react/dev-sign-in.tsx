"use client";

import { useId } from "react";
import { FlaskConical, Loader2, Zap } from "lucide-react";
import { clsx } from "clsx";

/**
 * localStorage key holding the last address used with the dev bypass
 * (CEL-1364). DEV-only convenience: it prefills the sign-in email so a fresh
 * tab is one click from a session. Read and written exclusively behind
 * `import.meta.env.DEV`, so production builds never touch it.
 */
export const DEV_LOGIN_EMAIL_STORAGE_KEY = "cellarnode.dev.login-email";

/**
 * Last address used with the dev bypass, or null.
 *
 * Tolerant by design — storage access throws in Safari private mode and in
 * any non-browser host (SSR, tests), and a prefill is never worth a crash.
 */
export function readDevLoginEmail(): string | null {
  try {
    const value = globalThis.localStorage?.getItem(DEV_LOGIN_EMAIL_STORAGE_KEY);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Remember `email` for the next dev sign-in. Silently no-ops on failure. */
export function rememberDevLoginEmail(email: string): void {
  try {
    globalThis.localStorage?.setItem(DEV_LOGIN_EMAIL_STORAGE_KEY, email);
  } catch {
    // Storage unavailable — the prefill is optional.
  }
}

export interface DevSignInBypassProps {
  /** Address the bypass will sign in as — the sign-in form's own email field. */
  email: string;
  /** True while the bypass request is in flight. */
  isSubmitting: boolean;
  /** True while the OTP form is busy, so the two affordances can't race. */
  disabled?: boolean;
  /** Developer-facing failure message from `authStore.devLogin()`. */
  error?: string;
  onDevSignIn: () => void;
}

/**
 * DEV-only affordance rendered ALONGSIDE the OTP email form (CEL-1364).
 *
 * It is strictly additive: the OTP flow above it stays fully reachable and
 * testable, and nothing here auto-submits or auto-redirects. A developer opts
 * in with a click.
 *
 * The component is only ever referenced from inside an
 * `import.meta.env.DEV && …` branch, so production bundles drop the branch and
 * this component with it (the package sets `sideEffects: false`). The two
 * storage helpers above are called from live function bodies behind runtime
 * guards, so they survive as unreachable code — that difference is pinned in
 * `__tests__/dev-bypass-treeshake.test.ts`.
 */
export function DevSignInBypass({
  email,
  isSubmitting,
  disabled = false,
  error,
  onDevSignIn,
}: DevSignInBypassProps) {
  const headingId = useId();
  const hintId = useId();
  const hasEmail = email.length > 0;

  return (
    <section
      aria-labelledby={headingId}
      className="mt-8 rounded-lg border border-dashed border-border bg-muted/40 p-4"
    >
      <h2
        id={headingId}
        className="flex items-center gap-2 text-xs/5 font-semibold uppercase tracking-wide text-muted-foreground"
      >
        <FlaskConical className="size-3.5" aria-hidden="true" />
        Development only
      </h2>

      {/* Static copy — identical on every render, so it carries no signal about
          the address. It names both preconditions up front, which is what makes
          the uniform 404 tolerable to debug without the client guessing which
          one failed. */}
      <p id={hintId} className="mt-1.5 text-sm/6 text-muted-foreground">
        Sign in as the address above without an emailed code. Requires the API
        to run with <code className="font-mono">ENABLE_TEST_ENDPOINTS=true</code>{" "}
        and a local account for that address.
      </p>

      <button
        type="button"
        onClick={onDevSignIn}
        disabled={disabled || isSubmitting || !hasEmail}
        aria-describedby={hintId}
        className={clsx(
          "mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-border bg-background px-4 text-sm font-medium text-foreground shadow-xs transition-colors",
          "hover:bg-muted focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
          "disabled:pointer-events-none disabled:opacity-50",
        )}
      >
        {isSubmitting ? (
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <Zap className="size-4" aria-hidden="true" />
        )}
        Dev sign-in (skip the code)
      </button>

      {error && (
        <p role="alert" className="mt-3 text-sm/6 text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
