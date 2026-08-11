"use client";

import * as React from "react";
import { OTPInput, OTPInputContext } from "input-otp";
import { clsx } from "clsx";
import { Minus } from "lucide-react";

export type InputOTPProps = React.ComponentProps<typeof OTPInput> & {
  containerClassName?: string;
  "data-invalid"?: boolean;
  "data-shaking"?: boolean;
};

const OTP_STYLES = `
  @keyframes caretBlink {
    0%, 70% { opacity: 1; }
    71%, 100% { opacity: 0; }
  }
  @keyframes fadeInSlot {
    from { opacity: 0; transform: scale(0.8); }
    to { opacity: 1; transform: scale(1); }
  }
  @keyframes otpShake {
    0%, 100% { transform: translateX(0); }
    15%, 45%, 75% { transform: translateX(-6px); }
    30%, 60%, 90% { transform: translateX(6px); }
  }
  [data-slot="input-otp-group"] > [data-slot="input-otp-slot"] {
    border-left-width: 0;
  }
  [data-slot="input-otp-slot"] {
    width: var(--input-otp-slot-width, 52px);
  }
  [data-slot="input-otp-root"] > [data-input-otp-container] {
    --input-otp-slot-width: min(
      52px,
      calc((100cqw - 24px) / var(--input-otp-slot-count))
    );
    --input-otp-separator-width: 24px;
  }
  [data-slot="input-otp-group"] > [data-slot="input-otp-slot"]:first-child {
    border-left-width: 2px;
    border-top-left-radius: 12px;
    border-bottom-left-radius: 12px;
  }
  [data-slot="input-otp-group"] > [data-slot="input-otp-slot"]:last-child {
    border-top-right-radius: 12px;
    border-bottom-right-radius: 12px;
  }
  [data-slot="input-otp-slot"][data-active] {
    border-left-width: 2px !important;
    margin-left: -2px;
    border-color: var(--primary, #2d6a5e) !important;
    z-index: 10;
  }
  [data-slot="input-otp-group"] > [data-slot="input-otp-slot"][data-active]:first-child {
    margin-left: 0;
  }
  [data-slot="input-otp-root"][data-invalid] [data-slot="input-otp-slot"] {
    border-color: var(--destructive, #ef4444) !important;
  }
  [data-slot="input-otp-root"][data-invalid] [data-slot="input-otp-slot"][data-active] {
    border-color: var(--destructive, #ef4444) !important;
    box-shadow: 0 0 0 3px color-mix(in oklab, var(--destructive, #ef4444) 20%, transparent), 0 1px 2px 0 rgba(0,0,0,0.05);
  }
  [data-slot="input-otp-root"][data-shaking] {
    animation: otpShake 0.4s ease;
  }
  @media (prefers-reduced-motion: reduce) {
    [data-slot="input-otp-root"],
    [data-slot="input-otp"],
    [data-slot="input-otp"] * {
      animation: none !important;
      transition: none !important;
    }
  }
`;

export function InputOTP({
  containerClassName,
  "data-invalid": dataInvalid,
  "data-shaking": dataShaking,
  ...props
}: InputOTPProps) {
  const containerStyle = {
    containerType: "inline-size",
    "--input-otp-slot-count": props.maxLength ?? 6,
  } satisfies React.CSSProperties & { "--input-otp-slot-count": number };

  return (
    <>
      <style>{OTP_STYLES}</style>
      <div
        data-slot="input-otp-root"
        data-invalid={dataInvalid ? true : undefined}
        data-shaking={dataShaking ? true : undefined}
        className="w-full"
        style={containerStyle}
      >
        <OTPInput
          data-slot="input-otp"
          data-invalid={dataInvalid ? true : undefined}
          data-shaking={dataShaking ? true : undefined}
          containerClassName={clsx(
            "flex w-full items-center has-disabled:opacity-50",
            containerClassName,
          )}
          {...props}
        />
      </div>
    </>
  );
}

export function InputOTPGroup({
  className,
  style,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-otp-group"
      style={{ display: "flex", alignItems: "center", ...style }}
      className={className}
      {...props}
    />
  );
}

export function InputOTPSlot({
  index,
  className,
  ...props
}: React.ComponentProps<"div"> & { index: number }) {
  const inputOTPContext = React.useContext(OTPInputContext);
  const slot = inputOTPContext.slots[index];
  if (!slot) return null;
  const { char, hasFakeCaret, isActive } = slot;

  return (
    <div
      data-slot="input-otp-slot"
      data-active={isActive || undefined}
      data-filled={!!char || undefined}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "60px",
        fontSize: "24px",
        fontWeight: 600,
        lineHeight: 1,
        transition: "all 150ms ease",
        border: "2px solid var(--border, #d1d5db)",
        background: char
          ? "var(--accent, #f1f5f9)"
          : "var(--background, #ffffff)",
        color: "var(--foreground, #0f172a)",
        boxShadow: isActive
          ? "0 0 0 3px color-mix(in oklab, var(--primary, #2d6a5e) 20%, transparent), 0 1px 2px 0 rgba(0,0,0,0.05)"
          : "0 1px 2px 0 rgba(0,0,0,0.05)",
      }}
      className={className}
      {...props}
    >
      {char && (
        <span style={{ animation: "fadeInSlot 150ms ease" }}>{char}</span>
      )}
      {!char && !hasFakeCaret && !isActive && (
        <span
          style={{
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            background: "var(--muted-foreground, #94a3b8)",
            opacity: 0.25,
          }}
        />
      )}
      {hasFakeCaret && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              width: "2px",
              height: "24px",
              borderRadius: "1px",
              background: "var(--primary, #2d6a5e)",
              animation: "caretBlink 1.1s ease infinite",
            }}
          />
        </div>
      )}
    </div>
  );
}

export function InputOTPSeparator({
  style,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-otp-separator"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "var(--input-otp-separator-width, 24px)",
        color: "var(--muted-foreground, #94a3b8)",
        ...style,
      }}
      {...props}
    >
      <hr
        style={{
          position: "absolute",
          width: "1px",
          height: "1px",
          padding: 0,
          margin: "-1px",
          overflow: "hidden",
          clip: "rect(0, 0, 0, 0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      />
      <Minus style={{ width: "20px", height: "20px" }} />
    </div>
  );
}
