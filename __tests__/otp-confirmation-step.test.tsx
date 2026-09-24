// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
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

  const OTPInput = ReactModule.forwardRef<
    HTMLInputElement,
    {
      value?: string;
      onChange?: (value: string) => void;
      maxLength?: number;
      children?: React.ReactNode;
      disabled?: boolean;
      containerClassName?: string;
      [key: string]: unknown;
    }
  >(({ value, onChange, maxLength, children, disabled, containerClassName: _containerClassName, ...rest }, ref) => {
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
        ref,
        "data-testid": "otp-hidden-input",
        "data-input-otp": true,
        disabled,
        value: value ?? "",
        onChange: (e: { target: { value: string } }) => onChange?.(e.target.value),
        ...rest,
      }),
      children,
    );
  });

  return { OTPInput, OTPInputContext, REGEXP_ONLY_DIGITS: "^\\d+$" };
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

    // CEL-2087 P1 review item 3: a bare `vi.advanceTimersByTimeAsync` can
    // resolve without React having flushed the resulting state updates,
    // making this test flaky (observed failing ~1 in 4 runs). Wrapping the
    // advance in `act()` forces React to flush before the next assertion.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onRequestCode).toHaveBeenCalledTimes(1);

    const resendButton = getByRole("button") as HTMLButtonElement;
    expect(resendButton.disabled).toBe(true);
    expect(resendButton.textContent).toContain("Resend in");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
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

describe("OtpConfirmationStep failure recovery (CEL-2087 P1 review item 1)", () => {
  it("a rate-limit or network failure on the mount request leaves Resend enabled with an actionable error", async () => {
    const onRequestCode = vi.fn(async () => {
      throw { code: "OTP_RATE_LIMIT" };
    });
    const { getByRole, findByRole } = render(
      <OtpConfirmationStep email="jane@example.com" onRequestCode={onRequestCode} onVerifyCode={vi.fn(async () => {})} />,
    );
    await waitFor(() => expect(onRequestCode).toHaveBeenCalledTimes(1));

    const alert = await findByRole("alert");
    expect(alert.textContent).toContain("Too many requests");

    const resendButton = getByRole("button") as HTMLButtonElement;
    expect(resendButton.disabled).toBe(false);
    expect(resendButton.textContent).toBe("Resend code");
  });

  it("a malformed resendAvailableAt timestamp does not permanently disable resend", async () => {
    const onRequestCode = vi.fn(async () => ({
      expiresAt: "not-a-real-date",
      resendAvailableAt: "not-a-real-date",
    }));
    const { getByRole } = render(
      <OtpConfirmationStep email="jane@example.com" onRequestCode={onRequestCode} onVerifyCode={vi.fn(async () => {})} />,
    );
    await waitFor(() => expect(onRequestCode).toHaveBeenCalledTimes(1));

    const resendButton = getByRole("button") as HTMLButtonElement;
    expect(resendButton.disabled).toBe(false);
  });
});

describe("OtpConfirmationStep idle state + initialTimings (CEL-2087 P1 review item 2)", () => {
  it("autoRequestOnMount=false starts idle with an explicit Send code action instead of being stuck on Sending", async () => {
    const onRequestCode = vi.fn(async () => ({
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      resendAvailableAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    const { getByRole, queryByTestId } = render(
      <OtpConfirmationStep
        email="jane@example.com"
        autoRequestOnMount={false}
        onRequestCode={onRequestCode}
        onVerifyCode={vi.fn(async () => {})}
      />,
    );
    await flush();
    expect(onRequestCode).not.toHaveBeenCalled();
    expect(queryByTestId("otp-hidden-input")).toBeNull();

    const sendButton = getByRole("button");
    expect(sendButton.textContent).toBe("Send code");

    fireEvent.click(sendButton);
    await waitFor(() => expect(onRequestCode).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(queryByTestId("otp-hidden-input")).not.toBeNull());
  });

  it("initialTimings starts directly in the sent state using the given timings, without auto-requesting", async () => {
    const onRequestCode = vi.fn(async () => ({
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      resendAvailableAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    const { getByTestId, getByRole } = render(
      <OtpConfirmationStep
        email="jane@example.com"
        autoRequestOnMount={false}
        initialTimings={{
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          resendAvailableAt: new Date(Date.now() + 60_000).toISOString(),
        }}
        onRequestCode={onRequestCode}
        onVerifyCode={vi.fn(async () => {})}
      />,
    );
    await flush();
    expect(onRequestCode).not.toHaveBeenCalled();
    expect(getByTestId("otp-hidden-input")).toBeTruthy();

    const resendButton = getByRole("button") as HTMLButtonElement;
    expect(resendButton.disabled).toBe(true);
    expect(resendButton.textContent).toContain("Resend in");
  });
});

describe("OtpConfirmationStep clock skew (CEL-2087 P2 review item 4)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("prefers resendAfterSeconds over the absolute resendAvailableAt when the client clock is skewed ahead", async () => {
    vi.useFakeTimers();
    // Client clock is 10 minutes AHEAD of the server: the server's absolute
    // resendAvailableAt (real server time) reads as already-past here, but
    // the relative seconds anchor to THIS client's receipt time instead.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    const onRequestCode = vi.fn(async () => ({
      expiresAt: new Date(Date.now() - 9 * 60_000).toISOString(),
      resendAvailableAt: new Date(Date.now() - 9 * 60_000).toISOString(),
      resendAfterSeconds: 60,
      expiresInSeconds: 900,
    }));
    const { getByRole } = render(
      <OtpConfirmationStep email="jane@example.com" onRequestCode={onRequestCode} onVerifyCode={vi.fn(async () => {})} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onRequestCode).toHaveBeenCalledTimes(1);

    const resendButton = getByRole("button") as HTMLButtonElement;
    // Using the (skewed-past) absolute timestamp would show resend as
    // already available. The relative seconds correctly keep it cooling down.
    expect(resendButton.disabled).toBe(true);
    expect(resendButton.textContent).toContain("Resend in");
  });
});

describe("OtpConfirmationStep expiry (CEL-2087 P2 review item 5)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows an expired-code notice once expiresAt passes", async () => {
    const onRequestCode = vi.fn(async () => ({
      expiresAt: new Date(Date.now() + 5_000).toISOString(),
      resendAvailableAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    const { getByText } = render(
      <OtpConfirmationStep email="jane@example.com" onRequestCode={onRequestCode} onVerifyCode={vi.fn(async () => {})} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onRequestCode).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    // A synchronous query, not `findByText`/`waitFor` — the state update
    // already flushed inside the `act()` above; RTL's async polling helpers
    // rely on real timers internally and can hang against a fake-timer clock.
    expect(getByText(/expired/i)).toBeTruthy();
  });
});

describe("OtpConfirmationStep accessibility (CEL-2087 P2 review item 6)", () => {
  it("links the input to its error via aria-invalid + aria-describedby", async () => {
    const onRequestCode = vi.fn(async () => ({
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      resendAvailableAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    const onVerifyCode = vi.fn(async () => {
      throw { code: "OTP_INVALID", remainingAttempts: 2 };
    });
    const { getByTestId, findByRole } = render(
      <OtpConfirmationStep email="jane@example.com" onRequestCode={onRequestCode} onVerifyCode={onVerifyCode} />,
    );
    await waitFor(() => expect(onRequestCode).toHaveBeenCalledTimes(1));

    const input = getByTestId("otp-hidden-input");
    fireEvent.change(input, { target: { value: "123456" } });
    const alert = await findByRole("alert");

    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(alert.id);
  });

  it("keeps the input readOnly (not disabled) + aria-busy during verify, so it stays focusable, and restores focus after a failed verify", async () => {
    const onRequestCode = vi.fn(async () => ({
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      resendAvailableAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    let rejectVerify: (() => void) | undefined;
    const onVerifyCode = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectVerify = () => reject({ code: "OTP_INVALID", remainingAttempts: 1 });
        }),
    );
    const { getByTestId } = render(
      <OtpConfirmationStep email="jane@example.com" onRequestCode={onRequestCode} onVerifyCode={onVerifyCode} />,
    );
    await waitFor(() => expect(onRequestCode).toHaveBeenCalledTimes(1));

    const input = getByTestId("otp-hidden-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "123456" } });
    await waitFor(() => expect(onVerifyCode).toHaveBeenCalled());

    // Not disabled — a disabled input can never receive focus, which is
    // exactly the property this test protects.
    expect(input.disabled).toBe(false);
    expect(input.getAttribute("aria-busy")).toBe("true");

    rejectVerify?.();
    await waitFor(() => expect(input.getAttribute("aria-busy")).not.toBe("true"));
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it("announces a successful resend via aria-live polite", async () => {
    const onRequestCode = vi.fn(async () => ({
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      resendAvailableAt: new Date(Date.now() - 1_000).toISOString(),
    }));
    const { getByRole, getByTestId } = render(
      <OtpConfirmationStep email="jane@example.com" onRequestCode={onRequestCode} onVerifyCode={vi.fn(async () => {})} />,
    );
    await waitFor(() => expect(onRequestCode).toHaveBeenCalledTimes(1));

    const resendButton = getByRole("button") as HTMLButtonElement;
    await waitFor(() => expect(resendButton.disabled).toBe(false));

    fireEvent.click(resendButton);
    await waitFor(() => expect(onRequestCode).toHaveBeenCalledTimes(2));

    await waitFor(() =>
      expect(getByTestId("resend-announcement").textContent).toBe("A new code has been sent."),
    );
  });
});

describe("OtpConfirmationStep StrictMode guard proof (CEL-2087 P2 review item 7)", () => {
  it("still fires onRequestCode exactly once under React.StrictMode's dev-only double-invoke (mutation proof for the one-flight guard)", async () => {
    const onRequestCode = vi.fn(async () => ({
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      resendAvailableAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    render(
      <StrictMode>
        <OtpConfirmationStep email="jane@example.com" onRequestCode={onRequestCode} onVerifyCode={vi.fn(async () => {})} />
      </StrictMode>,
    );
    await waitFor(() => expect(onRequestCode).toHaveBeenCalledTimes(1));
    await flush();
    expect(onRequestCode).toHaveBeenCalledTimes(1);
  });
});

describe("OtpConfirmationStep digits-only pattern (CEL-2087 P2 review item 9)", () => {
  it("sets pattern to digits-only, matching LoginForm's REGEXP_ONLY_DIGITS", async () => {
    const onRequestCode = vi.fn(async () => ({
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      resendAvailableAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    const { getByTestId } = render(
      <OtpConfirmationStep email="jane@example.com" onRequestCode={onRequestCode} onVerifyCode={vi.fn(async () => {})} />,
    );
    await waitFor(() => expect(onRequestCode).toHaveBeenCalledTimes(1));
    expect(getByTestId("otp-hidden-input").getAttribute("pattern")).toBe("^\\d+$");
  });
});

describe("OtpConfirmationStep resend-during-verify race (CEL-2087 P3 review item 11)", () => {
  it("an already-in-flight resend completing while a verify starts does not re-enable the input mid-verify", async () => {
    let resolveResend: (() => void) | undefined;
    let resendCalls = 0;
    const onRequestCode = vi.fn((isResend: boolean) => {
      if (isResend) {
        resendCalls += 1;
        return new Promise<{ expiresAt: string; resendAvailableAt: string }>((resolve) => {
          resolveResend = () =>
            resolve({
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
              resendAvailableAt: new Date(Date.now() + 60_000).toISOString(),
            });
        });
      }
      return Promise.resolve({
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        resendAvailableAt: new Date(Date.now() - 1_000).toISOString(), // available immediately
      });
    });
    // Never resolves — keeps status pinned at "verifying" for the duration
    // of this test, so a clobbering resend completion is observable.
    const onVerifyCode = vi.fn(() => new Promise<void>(() => {}));

    const { getByTestId, getByRole } = render(
      <OtpConfirmationStep email="jane@example.com" onRequestCode={onRequestCode} onVerifyCode={onVerifyCode} />,
    );
    await waitFor(() => expect(onRequestCode).toHaveBeenCalledTimes(1));

    const resendButton = getByRole("button") as HTMLButtonElement;
    await waitFor(() => expect(resendButton.disabled).toBe(false));
    fireEvent.click(resendButton); // starts an in-flight resend that will NOT resolve yet
    await waitFor(() => expect(resendCalls).toBe(1));

    const input = getByTestId("otp-hidden-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "123456" } }); // starts verify -> status "verifying"
    await waitFor(() => expect(onVerifyCode).toHaveBeenCalled());
    expect(input.getAttribute("aria-busy")).toBe("true");

    // The resend that was ALREADY in flight before verify started now
    // resolves. It must not clobber the "verifying" status back to "sent".
    resolveResend?.();
    await flush();

    expect(input.getAttribute("aria-busy")).toBe("true");
    expect(input.disabled).toBe(false);
  });
});

describe("OtpConfirmationStep stale response guard (CEL-2087 P3 review item 12)", () => {
  it("ignores a request-code response that arrives after the email prop has changed", async () => {
    let resolveFirst: ((timings: { expiresAt: string; resendAvailableAt: string }) => void) | undefined;
    const onRequestCode = vi.fn(
      () =>
        new Promise<{ expiresAt: string; resendAvailableAt: string }>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const { rerender, getByRole } = render(
      <OtpConfirmationStep email="first@example.com" onRequestCode={onRequestCode} onVerifyCode={vi.fn(async () => {})} />,
    );
    await waitFor(() => expect(onRequestCode).toHaveBeenCalledTimes(1));

    // Swap the email BEFORE the first request settles, with a second mock
    // that resolves immediately for the new email.
    const secondOnRequestCode = vi.fn(async () => ({
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      resendAvailableAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    rerender(
      <OtpConfirmationStep
        email="second@example.com"
        onRequestCode={secondOnRequestCode}
        onVerifyCode={vi.fn(async () => {})}
      />,
    );
    await waitFor(() => expect(secondOnRequestCode).toHaveBeenCalledTimes(1));
    await flush();
    const resendButtonBefore = (getByRole("button") as HTMLButtonElement).textContent;

    // Now let the STALE first-email request resolve, with timings that would
    // make resend immediately available if (incorrectly) applied.
    resolveFirst?.({
      expiresAt: new Date().toISOString(),
      resendAvailableAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await flush();

    // The stale response must not have overwritten the second email's state.
    expect((getByRole("button") as HTMLButtonElement).textContent).toBe(resendButtonBefore);
  });
});
