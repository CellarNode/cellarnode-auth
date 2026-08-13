// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginForm } from "../src/react/login-form.js";
import { DEV_LOGIN_EMAIL_STORAGE_KEY } from "../src/react/dev-sign-in.js";
import type { DevLoginResult } from "../src/types.js";

/**
 * CEL-1364 — the dev sign-in bypass is ADDITIVE. These tests pin the three
 * properties that make it safe to ship inside the shared login surface:
 *
 *   1. It never replaces or pre-empts the OTP flow (the email form is still
 *      there, and nothing signs in without a click).
 *   2. It is absent when `import.meta.env.DEV` is false, which is what Vite
 *      folds in a production build.
 *   3. A uniform-404 backend produces the env-gate hint, never a claim about
 *      the account.
 *
 * The SquircleShift panel is React.lazy'd and pulls in @react-three/fiber, so
 * it is stubbed out — it is irrelevant to the bypass.
 */

vi.mock("../src/react/squircle-shift.js", () => ({
  SquircleShift: () => <div data-testid="squircle" />,
}));

function buildProps(overrides: Record<string, unknown> = {}) {
  return {
    userType: "producer" as const,
    brandName: "CellarNode",
    authApi: {
      requestOtp: vi.fn(async () => ({
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        resendAvailableAt: new Date(Date.now() + 60_000).toISOString(),
      })),
      verifyOtp: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
      getMe: vi.fn(async () => ({
        id: "user_dev",
        email: "dev@example.com",
        name: "Dev",
        userType: "producer",
        orgId: "org_dev",
        roles: [],
        createdAt: "2024-01-01T00:00:00.000Z",
      })),
    },
    authStore: {
      setAccessToken: vi.fn(),
      clearAccessToken: vi.fn(),
      devLogin: vi.fn(
        async (): Promise<DevLoginResult> => ({
          ok: true,
          accessToken: "jwe.dev.token",
          expiresIn: 900,
          userId: "user_dev",
          orgId: "org_dev",
        }),
      ),
    },
    onLoginSuccess: vi.fn(),
    ...overrides,
  };
}

function renderLogin(props: ReturnType<typeof buildProps>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(<LoginForm {...(props as any)} />);
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("LoginForm dev bypass — DEV builds (CEL-1364)", () => {
  beforeEach(() => {
    vi.stubEnv("DEV", true);
  });

  it("renders alongside the OTP email form rather than replacing it", () => {
    // Given: a developer opens the shared sign-in surface locally.
    renderLogin(buildProps());

    // Then: the real OTP flow is intact and reachable...
    expect(screen.getByLabelText(/email address/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /continue/i })).toBeTruthy();

    // ...and the bypass sits beside it as a second, clearly-labelled option.
    expect(screen.getByRole("button", { name: /dev sign-in/i })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /development only/i })).toBeTruthy();
  });

  it("never signs in on its own", () => {
    // Given: the surface renders with a remembered address available.
    window.localStorage.setItem(DEV_LOGIN_EMAIL_STORAGE_KEY, "dev@example.com");
    const props = buildProps();

    // When: nothing is clicked.
    renderLogin(props);

    // Then: no session is minted and no redirect fires — the bypass is opt-in
    // per click, so the OTP page itself stays testable.
    expect(props.authStore.devLogin).not.toHaveBeenCalled();
    expect(props.onLoginSuccess).not.toHaveBeenCalled();
  });

  it("prefills the email from the dev-only localStorage key", async () => {
    // Given: a previous dev sign-in remembered an address.
    window.localStorage.setItem(DEV_LOGIN_EMAIL_STORAGE_KEY, "remembered@example.com");

    // When: the surface mounts.
    renderLogin(buildProps());

    // Then: the shared email field is prefilled, so the bypass is one click and
    // the OTP flow starts from the same address.
    await waitFor(() => {
      const input = screen.getByLabelText(/email address/i) as HTMLInputElement;
      expect(input.value).toBe("remembered@example.com");
    });
  });

  it("does not override an explicit initialEmail", async () => {
    // Given: the consumer passes an address (e.g. an invite link).
    window.localStorage.setItem(DEV_LOGIN_EMAIL_STORAGE_KEY, "remembered@example.com");

    // When: the surface mounts with initialEmail set.
    renderLogin(buildProps({ initialEmail: "invited@example.com" }));

    // Then: the consumer's value wins over the dev convenience.
    await waitFor(() => {
      const input = screen.getByLabelText(/email address/i) as HTMLInputElement;
      expect(input.value).toBe("invited@example.com");
    });
  });

  it("signs in through devLogin on click and remembers the address", async () => {
    // Given: a remembered address so the button is enabled without typing.
    window.localStorage.setItem(DEV_LOGIN_EMAIL_STORAGE_KEY, "dev@example.com");
    const props = buildProps();
    renderLogin(props);

    const button = await waitFor(() => {
      const el = screen.getByRole("button", { name: /dev sign-in/i }) as HTMLButtonElement;
      expect(el.disabled).toBe(false);
      return el;
    });

    // When: the developer clicks the bypass.
    button.click();

    // Then: the store helper mints the session and the consumer's success
    // callback runs — same terminal behaviour as a verified OTP.
    await waitFor(() => {
      expect(props.authStore.devLogin).toHaveBeenCalledWith("dev@example.com");
      expect(props.onLoginSuccess).toHaveBeenCalledTimes(1);
    });
    expect(window.localStorage.getItem(DEV_LOGIN_EMAIL_STORAGE_KEY)).toBe("dev@example.com");
  });

  it("surfaces the gate-off hint when the backend 404s, without blaming the address", async () => {
    // Given: a backend running without ENABLE_TEST_ENDPOINTS — the same 404 it
    // returns for an unknown address.
    window.localStorage.setItem(DEV_LOGIN_EMAIL_STORAGE_KEY, "dev@example.com");
    const props = buildProps();
    props.authStore.devLogin = vi.fn(async (): Promise<DevLoginResult> => ({
      ok: false,
      reason: "test-endpoints-disabled",
      status: 404,
      message:
        "Dev sign-in unavailable: backend test endpoints are disabled. Set ENABLE_TEST_ENDPOINTS=true on the API and restart it.",
    }));
    renderLogin(props);

    const button = await waitFor(() => {
      const el = screen.getByRole("button", { name: /dev sign-in/i }) as HTMLButtonElement;
      expect(el.disabled).toBe(false);
      return el;
    });

    // When: the bypass is attempted.
    button.click();

    // Then: the developer is told which env var to set, announced via an alert,
    // and no session is claimed.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("ENABLE_TEST_ENDPOINTS=true");
    expect(alert.textContent).not.toMatch(/no account|does not exist|not found/i);
    expect(props.onLoginSuccess).not.toHaveBeenCalled();
  });

  it("keeps the portal guard the OTP path applies", async () => {
    // Given: the address belongs to an importer but this is the producer portal.
    window.localStorage.setItem(DEV_LOGIN_EMAIL_STORAGE_KEY, "importer@example.com");
    const props = buildProps();
    props.authApi.getMe = vi.fn(async () => ({
      id: "user_imp",
      email: "importer@example.com",
      name: "Imp",
      userType: "importer",
      orgId: "org_imp",
      roles: [],
      createdAt: "2024-01-01T00:00:00.000Z",
    }));
    renderLogin(props);

    const button = await waitFor(() => {
      const el = screen.getByRole("button", { name: /dev sign-in/i }) as HTMLButtonElement;
      expect(el.disabled).toBe(false);
      return el;
    });

    // When: the bypass mints that session.
    button.click();

    // Then: the session is discarded and the portal message shown — the bypass
    // skips the code, not the access rules.
    await waitFor(() => {
      expect(props.authStore.clearAccessToken).toHaveBeenCalled();
    });
    expect((await screen.findByRole("alert")).textContent).toMatch(/producer accounts only/i);
    expect(props.onLoginSuccess).not.toHaveBeenCalled();
  });

  it("fails closed when /auth/me throws — an unresolvable user type is not a pass", async () => {
    // The dev path resolves the user type through a SEPARATE `/auth/me` call
    // (verifyOtp gets it inline). A transient failure there must NOT be allowed
    // to seat a session in the wrong portal.
    window.localStorage.setItem(DEV_LOGIN_EMAIL_STORAGE_KEY, "dev@example.com");
    const props = buildProps();
    props.authApi.getMe = vi.fn(async () => {
      throw new Error("network");
    });
    renderLogin(props);

    const button = await waitFor(() => {
      const el = screen.getByRole("button", { name: /dev sign-in/i }) as HTMLButtonElement;
      expect(el.disabled).toBe(false);
      return el;
    });

    button.click();

    await waitFor(() => {
      expect(props.authStore.clearAccessToken).toHaveBeenCalled();
    });
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /couldn't verify your account type/i,
    );
    expect(props.onLoginSuccess).not.toHaveBeenCalled();
  });

  it("fails closed when /auth/me answers without a userType", async () => {
    window.localStorage.setItem(DEV_LOGIN_EMAIL_STORAGE_KEY, "dev@example.com");
    const props = buildProps();
    props.authApi.getMe = vi.fn(async () => ({
      id: "user_dev",
      email: "dev@example.com",
      name: "Dev",
      orgId: "org_dev",
      roles: [],
      createdAt: "2024-01-01T00:00:00.000Z",
    }));
    renderLogin(props);

    const button = await waitFor(() => {
      const el = screen.getByRole("button", { name: /dev sign-in/i }) as HTMLButtonElement;
      expect(el.disabled).toBe(false);
      return el;
    });

    button.click();

    await waitFor(() => {
      expect(props.authStore.clearAccessToken).toHaveBeenCalled();
    });
    expect(props.onLoginSuccess).not.toHaveBeenCalled();
  });
});

describe("LoginForm dev bypass — production builds (CEL-1364)", () => {
  beforeEach(() => {
    // What Vite substitutes when it builds for production.
    vi.stubEnv("DEV", false);
  });

  it("is absent while the OTP flow is untouched", () => {
    // Given: a production build of a consumer dashboard.
    window.localStorage.setItem(DEV_LOGIN_EMAIL_STORAGE_KEY, "dev@example.com");
    renderLogin(buildProps());

    // Then: no bypass affordance exists at all...
    expect(screen.queryByRole("button", { name: /dev sign-in/i })).toBeNull();
    expect(screen.queryByRole("heading", { name: /development only/i })).toBeNull();

    // ...and the OTP flow is exactly what it was before this feature.
    expect(screen.getByLabelText(/email address/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /continue/i })).toBeTruthy();
  });

  it("does not read the dev localStorage key", () => {
    // Given: a stale dev key left in the browser.
    window.localStorage.setItem(DEV_LOGIN_EMAIL_STORAGE_KEY, "dev@example.com");

    // When: a production build mounts.
    renderLogin(buildProps());

    // Then: the email field stays empty — no dev-only state leaks into prod UX.
    const input = screen.getByLabelText(/email address/i) as HTMLInputElement;
    expect(input.value).toBe("");
  });
});
