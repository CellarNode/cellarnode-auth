"use client";

import { ShieldX, ArrowLeftRight, ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import type { DashboardLink } from "../types.js";

/**
 * Localizable copy for {@link UnauthorizedPage}. Every omitted field falls
 * back to its English default, so existing consumers are unaffected
 * (CEL-918; mirrors the labels pattern of @cellarnode/ui).
 */
export interface UnauthorizedPageLabels {
  /** Heading of the wrong-portal view. Default "Wrong Portal". */
  wrongPortalTitle?: string;
  /**
   * Full description under the wrong-portal heading. Overrides the composed
   * English default ("You're signed in as a {userType}. This dashboard is
   * for {expectedRole}.") — pass a fully-translated node (e.g. a <Trans>).
   */
  wrongPortalDescription?: ReactNode;
  /**
   * CTA text for the matching dashboard link. Receives the link's label.
   * Default: `Go to ${linkLabel}`.
   */
  goToDashboard?: (linkLabel: string) => ReactNode;
  /** Default "Sign in with a different account". */
  switchAccount?: string;
  /** Heading of the generic view. Default "Access Denied". */
  accessDeniedTitle?: string;
  /**
   * Full description under the access-denied heading. Overrides the composed
   * English default ("This dashboard is for {expectedRole} only. …").
   */
  accessDeniedDescription?: ReactNode;
  /** Default "Back to Login". */
  backToLogin?: string;
}

export interface UnauthorizedPageProps {
  expectedRole: string;
  onNavigateLogin: () => void | Promise<void>;
  authenticatedUserType?: string | null;
  dashboardLinks?: DashboardLink[];
  /** Optional label overrides; each omitted field uses its English default. */
  labels?: UnauthorizedPageLabels;
}

export function UnauthorizedPage({
  expectedRole,
  onNavigateLogin,
  authenticatedUserType,
  dashboardLinks,
  labels,
}: UnauthorizedPageProps) {
  const matchingLink =
    authenticatedUserType && dashboardLinks
      ? dashboardLinks.find((l) => l.userType === authenticatedUserType)
      : undefined;

  // Portal-aware view: user is authenticated but on the wrong dashboard
  if (matchingLink) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background text-foreground p-4">
        <div className="mx-auto w-full max-w-md rounded-xl border border-border bg-card p-8 text-center text-card-foreground shadow-sm">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-amber-500/10">
            <ArrowLeftRight className="size-6 text-amber-600" />
          </div>
          <h1 className="text-2xl font-semibold">
            {labels?.wrongPortalTitle ?? "Wrong Portal"}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {labels?.wrongPortalDescription ?? (
              <>
                You're signed in as a{" "}
                <span className="font-medium text-foreground">
                  {authenticatedUserType}
                </span>
                . This dashboard is for {expectedRole}.
              </>
            )}
          </p>
          <a
            href={matchingLink.url}
            className="mt-6 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90 transition-colors"
          >
            {labels?.goToDashboard
              ? labels.goToDashboard(matchingLink.label)
              : `Go to ${matchingLink.label}`}
            <ExternalLink className="size-4" />
          </a>
          <button
            type="button"
            onClick={onNavigateLogin}
            className="mt-3 text-sm text-primary transition-colors hover:text-primary/80"
          >
            {labels?.switchAccount ?? "Sign in with a different account"}
          </button>
        </div>
      </div>
    );
  }

  // Fallback: generic access denied (backward compat + admin userType + no props)
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background text-foreground p-4">
      <div className="mx-auto w-full max-w-md rounded-xl border border-border bg-card p-8 text-center text-card-foreground shadow-sm">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-destructive/10">
          <ShieldX className="size-6 text-destructive" />
        </div>
        <h1 className="text-2xl font-semibold">
          {labels?.accessDeniedTitle ?? "Access Denied"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {labels?.accessDeniedDescription ?? (
            <>
              This dashboard is for {expectedRole} only. If you believe this is
              an error, please contact support.
            </>
          )}
        </p>
        <button
          type="button"
          onClick={onNavigateLogin}
          className="mt-6 inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90 transition-colors"
        >
          {labels?.backToLogin ?? "Back to Login"}
        </button>
      </div>
    </div>
  );
}
