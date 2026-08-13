// @vitest-environment happy-dom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

  it("signs in as the address in the form and remembers THAT address", async () => {
    // Given: a STALE remembered address, which the DEV prefill loads.
    window.localStorage.setItem(DEV_LOGIN_EMAIL_STORAGE_KEY, "stale@example.com");
    const props = buildProps();
    renderLogin(props);

    const input = await waitFor(() => {
      const el = screen.getByLabelText(/email address/i) as HTMLInputElement;
      expect(el.value).toBe("stale@example.com");
      return el;
    });

    // ...and the developer types a DIFFERENT one. Seeding the key with the very
    // address the assertion then expects is what made the earlier version of
    // this test inert — it passed with `rememberDevLoginEmail` deleted. The
    // seed and the expectation must DISAGREE, so that only the code under test
    // can reconcile them.
    fireEvent.change(input, { target: { value: "fresh@example.com" } });

    const button = screen.getByRole("button", {
      name: /dev sign-in/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    // When: the developer clicks the bypass.
    button.click();

    // Then: it signs in as the TYPED address, and that address replaces the
    // stale one in storage.
    await waitFor(() => {
      expect(props.authStore.devLogin).toHaveBeenCalledWith("fresh@example.com");
      expect(props.onLoginSuccess).toHaveBeenCalledTimes(1);
    });
    expect(window.localStorage.getItem(DEV_LOGIN_EMAIL_STORAGE_KEY)).toBe(
      "fresh@example.com",
    );
  });

  it("surfaces an error when devLogin REJECTS rather than resolving a failure", async () => {
    // Given: a custom AuthStore that throws. `devLogin` is OPTIONAL on the
    // interface, so nothing forces an implementation to resolve DevLoginResult.
    const onError = vi.fn();
    const props = buildProps({ initialEmail: "dev@example.com", onError });
    props.authStore.devLogin = vi.fn(async (): Promise<DevLoginResult> => {
      throw new Error("store exploded");
    });
    renderLogin(props);

    const button = screen.getByRole("button", {
      name: /dev sign-in/i,
    }) as HTMLButtonElement;

    // When: the developer clicks the bypass.
    button.click();

    // Then: the failure reaches the SAME channel every other failure uses. Were
    // the rejection to escape the handler, `finally` would still re-enable the
    // button and this alert would never exist — a button that silently does
    // nothing is precisely the symptom this pins.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/store exploded/);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "DEV_LOGIN_UNEXPECTED" }),
    );
    expect(props.onLoginSuccess).not.toHaveBeenCalled();

    // And: the button is usable again, so a retry is one click away.
    await waitFor(() => {
      const el = screen.getByRole("button", {
        name: /dev sign-in/i,
      }) as HTMLButtonElement;
      expect(el.disabled).toBe(false);
    });
  });

  it("blocks the OTP submit while the bypass is in flight, so the two cannot race", async () => {
    // Given: a devLogin that never settles on its own.
    let release: (result: DevLoginResult) => void = () => {};
    const pending = new Promise<DevLoginResult>((resolve) => {
      release = resolve;
    });
    const props = buildProps({ initialEmail: "dev@example.com" });
    props.authStore.devLogin = vi.fn(() => pending);
    renderLogin(props);

    // When: the bypass is clicked and left in flight.
    (
      screen.getByRole("button", { name: /dev sign-in/i }) as HTMLButtonElement
    ).click();

    // Then: "Continue" is disabled too. Without the reciprocal guard, requesting
    // an OTP here would advance to the OTP step, and the resolving bypass would
    // call onLoginSuccess() from a step that no longer renders it — the race
    // `DevSignInBypassProps.disabled` claims cannot happen.
    const cont = await waitFor(() => {
      const el = screen.getByRole("button", {
        name: /continue/i,
      }) as HTMLButtonElement;
      expect(el.disabled).toBe(true);
      return el;
    });
    cont.click();
    expect(props.authApi.requestOtp).not.toHaveBeenCalled();

    // Cleanup: settle the promise so the component is not left mid-update.
    release({
      ok: true,
      accessToken: "jwe.dev.token",
      expiresIn: 900,
      userId: "user_dev",
      orgId: "org_dev",
    });
    await waitFor(() => {
      expect(props.onLoginSuccess).toHaveBeenCalledTimes(1);
    });
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
