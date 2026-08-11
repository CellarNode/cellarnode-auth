import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "../src/react/input-otp-slots.js";
import { LoginForm } from "../src/react/login-form.js";
import type { AuthApi, AuthStore } from "../src/types.js";

const authApi = {
  requestOtp: async () => ({
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    resendAvailableAt: new Date(Date.now() + 60_000).toISOString(),
  }),
  verifyOtp: async () => ({
    accessToken: "access-token",
    expiresIn: 900,
    user: {
      id: "user-1",
      email: "user@example.com",
      name: "User",
      phone: "",
      userType: "importer" as const,
      orgId: null,
      roles: [],
    },
  }),
} satisfies Pick<AuthApi, "requestOtp" | "verifyOtp">;

const authStore = {
  setAccessToken: () => {},
  clearAccessToken: () => {},
} satisfies Pick<AuthStore, "setAccessToken" | "clearAccessToken">;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  cleanup();
  vi.useRealTimers();
});

describe("LoginForm narrow OTP layout", () => {
  it("renders six OTP targets inside a responsive full-width container", async () => {
    const { container, getByLabelText, getByRole } = render(
      <LoginForm
        userType="importer"
        brandName="CellarNode"
        authApi={authApi}
        authStore={authStore}
        onLoginSuccess={() => {}}
      />,
    );

    fireEvent.change(getByLabelText("Email address"), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(getByRole("button", { name: "Continue" }));

    await Promise.resolve();
    await vi.runAllTimersAsync();
    expect(getByRole("heading", { name: "Check your email" })).toBeTruthy();
    const otp = container.querySelector<HTMLElement>(
      '[data-slot="input-otp-root"]',
    );
    const slots = container.querySelectorAll('[data-slot="input-otp-slot"]');
    const otpStyles = container.querySelector("style");
    const responsiveSlotRule = Array.from(
      otpStyles?.sheet?.cssRules ?? [],
    ).find(
      (rule): rule is CSSStyleRule =>
        rule instanceof CSSStyleRule &&
        rule.selectorText ===
          '[data-slot="input-otp-root"] > [data-input-otp-container]',
    );

    expect(otp).not.toBeNull();
    expect(otp?.classList).toContain("w-full");
    expect(otp?.style.containerType).toBe("inline-size");
    expect(slots).toHaveLength(6);
    expect(
      responsiveSlotRule?.style.getPropertyValue("--input-otp-slot-width"),
    ).toContain("100cqw");
    expect(
      responsiveSlotRule?.style.getPropertyValue("--input-otp-slot-width"),
    ).toContain("var(--input-otp-slot-count)");
  });

  it("derives slot sizing from configurable OTP length", () => {
    const { container } = render(
      <InputOTP maxLength={4} data-invalid={false} data-shaking={false}>
        <InputOTPGroup>
          <InputOTPSlot index={0} />
          <InputOTPSlot index={1} />
          <InputOTPSlot index={2} />
          <InputOTPSlot index={3} />
        </InputOTPGroup>
      </InputOTP>,
    );

    const otp = container.querySelector<HTMLElement>(
      '[data-slot="input-otp-root"]',
    );
    const slots = container.querySelectorAll('[data-slot="input-otp-slot"]');
    const hiddenInput = container.querySelector('[data-input-otp]');

    expect(otp?.style.getPropertyValue("--input-otp-slot-count")).toBe("4");
    expect(otp?.hasAttribute("data-invalid")).toBe(false);
    expect(otp?.hasAttribute("data-shaking")).toBe(false);
    expect(slots).toHaveLength(4);
    expect(hiddenInput?.getAttribute("data-slot")).toBe("input-otp");
  });

  it("preserves separator semantics", () => {
    const { getByRole } = render(<InputOTPSeparator />);

    expect(getByRole("separator")).toBeTruthy();
  });

  it("marks invalid slots with a cascade-safe destructive border", () => {
    const { container } = render(
      <InputOTP maxLength={4} value="1" data-invalid>
        <InputOTPGroup>
          <InputOTPSlot index={0} />
          <InputOTPSlot index={1} />
          <InputOTPSlot index={2} />
          <InputOTPSlot index={3} />
        </InputOTPGroup>
      </InputOTP>,
    );

    const root = container.querySelector('[data-slot="input-otp-root"]');
    const otpStyles = container.querySelector("style")?.textContent ?? "";
    const invalidRule = otpStyles.match(
      /\[data-slot="input-otp-root"\]\[data-invalid\] \[data-slot="input-otp-slot"\] \{[^}]+\}/,
    )?.[0];

    expect(root?.hasAttribute("data-invalid")).toBe(true);
    expect(invalidRule).toContain(
      "border-color: var(--destructive, #ef4444) !important",
    );
  });
});
