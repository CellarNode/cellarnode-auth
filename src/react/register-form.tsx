"use client";

import { useState } from "react";
import type { AuthApi } from "../types.js";
import { AuthError } from "../types.js";
import { Loader2 } from "lucide-react";

export interface RegisterFormProps {
  userType: "importer" | "producer";
  onRegistered: () => void;
  onNavigateLogin: () => void;
  authApi: AuthApi;
}

export function RegisterForm({
  userType,
  onRegistered,
  onNavigateLogin,
  authApi,
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
      <div className="rounded-xl border border-border bg-card shadow-sm">
        <div className="p-6 text-center">
          <h2 className="text-2xl font-semibold">Check your email</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            We sent a verification link to {email}. After verifying, you can
            log in.
          </p>
        </div>
        <div className="px-6 pb-6">
          <button
            onClick={onNavigateLogin}
            className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90 transition-colors"
          >
            Go to Login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm">
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
              autoFocus
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
    </div>
  );
}
