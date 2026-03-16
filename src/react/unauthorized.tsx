"use client";

import { ShieldX, ArrowLeftRight, ExternalLink } from "lucide-react";
import type { DashboardLink } from "../types.js";

export interface UnauthorizedPageProps {
  expectedRole: string;
  onNavigateLogin: () => void | Promise<void>;
  authenticatedUserType?: string | null;
  dashboardLinks?: DashboardLink[];
}

export function UnauthorizedPage({
  expectedRole,
  onNavigateLogin,
  authenticatedUserType,
  dashboardLinks,
}: UnauthorizedPageProps) {
  const matchingLink =
    authenticatedUserType && dashboardLinks
      ? dashboardLinks.find((l) => l.userType === authenticatedUserType)
      : undefined;

  // Portal-aware view: user is authenticated but on the wrong dashboard
  if (matchingLink) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-4">
        <div className="mx-auto w-full max-w-md rounded-xl border border-border bg-card p-8 text-center shadow-sm">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-amber-500/10">
            <ArrowLeftRight className="size-6 text-amber-600" />
          </div>
          <h1 className="text-2xl font-semibold">Wrong Portal</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            You're signed in as a{" "}
            <span className="font-medium text-foreground">
              {authenticatedUserType}
            </span>
            . This dashboard is for {expectedRole}.
          </p>
          <a
            href={matchingLink.url}
            className="mt-6 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90 transition-colors"
          >
            Go to {matchingLink.label}
            <ExternalLink className="size-4" />
          </a>
          <button
            onClick={onNavigateLogin}
            className="mt-3 text-sm text-primary transition-colors hover:text-primary/80"
          >
            Sign in with a different account
          </button>
        </div>
      </div>
    );
  }

  // Fallback: generic access denied (backward compat + admin userType + no props)
  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <div className="mx-auto w-full max-w-md rounded-xl border border-border bg-card p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-destructive/10">
          <ShieldX className="size-6 text-destructive" />
        </div>
        <h1 className="text-2xl font-semibold">Access Denied</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This dashboard is for {expectedRole} only. If you believe this is an
          error, please contact support.
        </p>
        <button
          onClick={onNavigateLogin}
          className="mt-6 inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90 transition-colors"
        >
          Back to Login
        </button>
      </div>
    </div>
  );
}
