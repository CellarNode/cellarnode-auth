import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LoginForm, otpSentNotice } from "../src/react/login-form.js";
import { classTokensAt } from "./class-tokens.js";

// CEL-964: the login form must not leak whether an account exists. The old
// USER_NOT_FOUND branch (which showed "No account found" + a create-account CTA
// only on failure) is gone; a create-account affordance is now shown
// unconditionally on the email step, and the post-submit copy is uniform.
//
// The suite renders to static markup (react-dom/server) to stay on the repo's
// node-only vitest setup — same pattern as unauthorized.test.tsx. Static markup
// renders the email step (initial state), which is where the anti-enumeration
// guarantees are visible.

const noop = () => {};

// The component only touches these in event handlers, never during render, so
// minimal stubs are enough for a static-markup render.
const authApi = {
  requestOtp: async () => ({
    expiresAt: new Date().toISOString(),
    resendAvailableAt: new Date().toISOString(),
  }),
  verifyOtp: async () => ({
    accessToken: "",
    expiresIn: 0,
    user: { id: "", email: "", name: "", phone: "", userType: "importer", orgId: null, roles: [] },
  }),
} as any;

const authStore = {
  setAccessToken: noop,
  clearAccessToken: noop,
} as any;

function renderEmailStep(extraProps: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    <LoginForm
      userType="importer"
      brandName="CellarNode"
      authApi={authApi}
      authStore={authStore}
      onLoginSuccess={noop}
      {...extraProps}
    />,
  );
}

describe("LoginForm anti-enumeration (CEL-964)", () => {
  it("owns a semantic background and foreground at its page boundary", () => {
    // Given: a consumer rendering the shared full-page login surface.
    // When: the email step is rendered.
    const html = renderEmailStep();

    // Then: theme-aware text always has a matching theme-aware surface.
    expect(classTokensAt(html, 0)).toEqual(
      expect.arrayContaining(["bg-background", "text-foreground"]),
    );
  });

  it("shows a create-account affordance unconditionally on the email step", () => {
    const html = renderEmailStep();

    // Default footerText is a create-account affordance, always rendered on the
    // email step so a new user is never stranded.
    expect(html).toContain("Need an account?");
    expect(html).toContain("Contact your CellarNode representative.");
  });

  it("renders a clickable register CTA when the consumer enables it", () => {
    const html = renderEmailStep({ showRegisterInFooter: true, onNavigateRegister: noop });

    expect(html).toContain("Need an account?");
    expect(html).toContain("Register here");
  });

  it("does not leak account existence on the email step", () => {
    const html = renderEmailStep();

    // The removed USER_NOT_FOUND copy must never appear.
    expect(html).not.toContain("No account found");
    // The neutral email prompt is what shows instead.
    expect(html).toContain("Enter your work email to receive a one-time access code.");
  });

  it("otpSentNotice renders the uniform, existence-agnostic copy", () => {
    expect(otpSentNotice("user@example.com")).toBe(
      "If an account exists for user@example.com, we've sent a code.",
    );
    // No wording that confirms or denies an account.
    expect(otpSentNotice("user@example.com")).not.toContain("No account");
  });
});
