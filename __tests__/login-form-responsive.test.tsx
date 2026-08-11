import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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

afterEach(cleanup);

describe("LoginForm narrow OTP layout", () => {
  it("renders six OTP targets inside a responsive full-width container", async () => {
    const { container, findByRole, getByLabelText, getByRole } = render(
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

    await findByRole("heading", { name: "Check your email" });
    const otp = container.querySelector<HTMLElement>('[data-slot="input-otp"]');
    const slots = container.querySelectorAll('[data-slot="input-otp-slot"]');
    const otpStyles = container.querySelector("style");

    expect(otp).not.toBeNull();
    expect(otp?.classList).toContain("w-full");
    expect(otp?.style.containerType).toBe("inline-size");
    expect(slots).toHaveLength(6);
    expect(otpStyles?.textContent).toContain("--input-otp-slot-width");
  });
});
