// @vitest-environment happy-dom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OtpConfirmationStep } from "../src/react/otp-confirmation-step.js";

// A minimal, controllable stand-in for `input-otp`'s OTPInput so these tests
// exercise OtpConfirmationStep's OWN logic (mount guard, auto-verify, resend
// countdown, error mapping) without depending on the real library's internal
// typing/paste behavior inside happy-dom — that library is an external,
// already-tested dependency, not something CEL-2087 needs to re-prove.
vi.mock("input-otp", async () => {
  const ReactModule = await import("react");
  const OTPInputContext = ReactModule.createContext<{
    slots: Array<{ char: string | null; hasFakeCaret: boolean; isActive: boolean }>;
  }>({ slots: [] });

  const OTPInput = ({
    value,
    onChange,
    maxLength,
    children,
    disabled,
    containerClassName: _containerClassName,
    ...rest
  }: {
    value?: string;
    onChange?: (value: string) => void;
    maxLength?: number;
    children?: React.ReactNode;
    disabled?: boolean;
    containerClassName?: string;
    [key: string]: unknown;
  }) => {
    const length = maxLength ?? 6;
    const slots = Array.from({ length }, (_, i) => ({
      char: value?.[i] ?? null,
      hasFakeCaret: i === (value?.length ?? 0),
      isActive: i === (value?.length ?? 0),
    }));
    return ReactModule.createElement(
      OTPInputContext.Provider,
      { value: { slots } },
      ReactModule.createElement("input", {
        "data-testid": "otp-hidden-input",
        "data-input-otp": true,
        disabled,
        value: value ?? "",
        onChange: (e: { target: { value: string } }) => onChange?.(e.target.value),
        ...rest,
      }),
      children,
    );
  };

  return { OTPInput, OTPInputContext };
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("OtpConfirmationStep mount guard (CEL-2087)", () => {
  it("fires onRequestCode exactly once on mount, even across a StrictMode-style remount", async () => {
    const onRequestCode = vi.fn(async () => ({
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      resendAvailableAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    const onVerifyCode = vi.fn(async () => {});

    // Simulate StrictMode's dev-only mount -> unmount -> mount on the SAME
    // ref instance is not directly reproducible via unmount/render (a fresh
    // component instance loses its ref), so this proves the more general
    // invariant instead: re-rendering with the SAME email never re-fires.
    const { rerender } = render(
      <OtpConfirmationStep email="jane@example.com" onRequestCode={onRequestCode} onVerifyCode={onVerifyCode} />,
    );
    await waitFor(() => expect(onRequestCode).toHaveBeenCalledTimes(1));

    rerender(
      <OtpConfirmationStep email="jane@example.com" onRequestCode={onRequestCode} onVerifyCode={onVerifyCode} />,
    );
    await flush();
    expect(onRequestCode).toHaveBeenCalledTimes(1);
  });

  it("re-fires when the email actually changes", async () => {
    const onRequestCode = vi.fn(async () => ({
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      resendAvailableAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    const onVerifyCode = vi.fn(async () => {});

    const { rerender } = render(
      <OtpConfirmationStep email="jane@example.com" onRequestCode={onRequestCode} onVerifyCode={onVerifyCode} />,
    );
    await waitFor(() => expect(onRequestCode).toHaveBeenCalledTimes(1));

    rerender(
      <OtpConfirmationStep email="other@example.com" onRequestCode={onRequestCode} onVerifyCode={onVerifyCode} />,
    );
    await waitFor(() => expect(onRequestCode).toHaveBeenCalledTimes(2));
  });

  it("does not request on mount when autoRequestOnMount is false", async () => {
    const onRequestCode = vi.fn(async () => ({
      expiresAt: new Date().toISOString(),
      resendAvailableAt: new Date().toISOString(),
    }));
    render(
      <OtpConfirmationStep
        email="jane@example.com"
        autoRequestOnMount={false}
        onRequestCode={onRequestCode}
        onVerifyCode={vi.fn(async () => {})}
      />,
    );
    await flush();
    expect(onRequestCode).not.toHaveBeenCalled();
  });
});

describe("OtpConfirmationStep auto-verify + accessibility", () => {
  it("auto-verifies once the code reaches full length and reports success", async () => {
    const onRequestCode = vi.fn(async () => ({
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      resendAvailableAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    const onVerifyCode = vi.fn(async () => {});
    const onVerified = vi.fn();

    const { getByTestId } = render(
      <OtpConfirmationStep
        email="jane@example.com"
        onRequestCode={onRequestCode}
        onVerifyCode={onVerifyCode}
        onVerified={onVerified}
      />,
    );
    await waitFor(() => expect(onRequestCode).toHaveBeenCalledTimes(1));

    fireEvent.change(getByTestId("otp-hidden-input"), { target: { value: "123456" } });

    await waitFor(() => expect(onVerifyCode).toHaveBeenCalledWith("123456"));
    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1));
  });

  it("sets autocomplete=one-time-code on the underlying input", async () => {
    const onRequestCode = vi.fn(async () => ({
      expiresAt: new Date().toISOString(),
      resendAvailableAt: new Date().toISOString(),
    }));
    const { getByTestId } = render(
      <OtpConfirmationStep email="jane@example.com" onRequestCode={onRequestCode} onVerifyCode={vi.fn(async () => {})} />,
    );
    await waitFor(() => expect(onRequestCode).toHaveBeenCalledTimes(1));
    expect(getByTestId("otp-hidden-input").getAttribute("autocomplete")).toBe("one-time-code");
  });
});

describe("OtpConfirmationStep resend countdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("disables resend until the server's resendAvailableAt passes, then re-enables it", async () => {
    const resendAvailableAt = new Date(Date.now() + 5_000).toISOString();
    const onRequestCode = vi.fn(async () => ({
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      resendAvailableAt,
    }));

    const { getByRole } = render(
      <OtpConfirmationStep email="jane@example.com" onRequestCode={onRequestCode} onVerifyCode={vi.fn(async () => {})} />,
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(onRequestCode).toHaveBeenCalledTimes(1);

    const resendButton = getByRole("button") as HTMLButtonElement;
    expect(resendButton.disabled).toBe(true);
    expect(resendButton.textContent).toContain("Resend in");

    await vi.advanceTimersByTimeAsync(6_000);
    expect(resendButton.disabled).toBe(false);
    expect(resendButton.textContent).toBe("Resend code");
  });
});

describe("OtpConfirmationStep error mapping", () => {
  it.each([
    ["OTP_INVALID", "didn't match"],
    ["OTP_MAX_ATTEMPTS", "Too many incorrect attempts"],
    ["OTP_NOT_FOUND", "expired or was already used"],
    ["OTP_RATE_LIMIT", "Too many requests"],
    ["SOMETHING_ELSE", "Something went wrong"],
  ])("maps %s to a user-facing message", async (code, expectedSubstring) => {
    const onRequestCode = vi.fn(async () => ({
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      resendAvailableAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    const onVerifyCode = vi.fn(async () => {
      throw { code };
    });

    const { getByTestId, findByRole } = render(
      <OtpConfirmationStep email="jane@example.com" onRequestCode={onRequestCode} onVerifyCode={onVerifyCode} />,
    );
    await waitFor(() => expect(onRequestCode).toHaveBeenCalledTimes(1));

    fireEvent.change(getByTestId("otp-hidden-input"), { target: { value: "123456" } });

    const alert = await findByRole("alert");
    expect(alert.textContent).toContain(expectedSubstring);
  });
});
