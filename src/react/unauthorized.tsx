"use client";

import { ShieldX } from "lucide-react";

export interface UnauthorizedPageProps {
  expectedRole: string;
  onNavigateLogin: () => void;
}

export function UnauthorizedPage({
  expectedRole,
  onNavigateLogin,
}: UnauthorizedPageProps) {
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
