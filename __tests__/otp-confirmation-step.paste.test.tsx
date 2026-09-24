// @vitest-environment happy-dom

// CEL-2087 P2 review item 8: exercise the paste handler against the REAL
// `input-otp` library, not the hand-rolled stand-in the sibling test file
// mocks it with — that mock never implements paste, so it can't prove
// anything about the actual paste path. Deliberately no `vi.mock("input-otp")`
// here.
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OtpConfirmationStep } from "../src/react/otp-confirmation-step.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("OtpConfirmationStep paste (real input-otp)", () => {
  it("auto-verifies a pasted 6-digit code via the real input-otp paste handler", async () => {
    const onRequestCode = vi.fn(async () => ({
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      resendAvailableAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    const onVerifyCode = vi.fn(async () => {});

    const { container } = render(
      <OtpConfirmationStep email="jane@example.com" onRequestCode={onRequestCode} onVerifyCode={onVerifyCode} />,
    );
    await waitFor(() => expect(onRequestCode).toHaveBeenCalledTimes(1));

    const input = container.querySelector("input[data-input-otp]") as HTMLInputElement;
    expect(input).toBeTruthy();
    input.focus();

    fireEvent.paste(input, { clipboardData: { getData: () => "123456" } });

    await waitFor(() => expect(onVerifyCode).toHaveBeenCalledWith("123456"));
  });
});
