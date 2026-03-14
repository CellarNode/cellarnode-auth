"use client";

import * as React from "react";
import { OTPInput, OTPInputContext } from "input-otp";
import { clsx } from "clsx";
import { Dot } from "lucide-react";

export type InputOTPProps = React.ComponentProps<typeof OTPInput> & {
  containerClassName?: string;
};

export function InputOTP({ containerClassName, ...props }: InputOTPProps) {
  return (
    <OTPInput
      data-slot="input-otp"
      containerClassName={clsx(
        "flex items-center has-disabled:opacity-50",
        containerClassName,
      )}
      {...props}
    />
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
      style={{ display: "flex", alignItems: "center", gap: "8px", ...style }}
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
        width: "52px",
        height: "60px",
        borderRadius: "12px",
        fontSize: "24px",
        fontWeight: 600,
        lineHeight: 1,
        transition: "all 150ms ease",
        border: isActive
          ? "2px solid var(--primary, #2d6a5e)"
          : char
            ? "2px solid var(--border, #d1d5db)"
            : "2px solid var(--border, #d1d5db)",
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
      <style
        dangerouslySetInnerHTML={{
          __html: `
            @keyframes caretBlink {
              0%, 70% { opacity: 1; }
              71%, 100% { opacity: 0; }
            }
            @keyframes fadeInSlot {
              from { opacity: 0; transform: scale(0.8); }
              to { opacity: 1; transform: scale(1); }
            }
          `,
        }}
      />
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
      role="separator"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "16px",
        color: "var(--muted-foreground, #94a3b8)",
        ...style,
      }}
      {...props}
    >
      <Dot style={{ width: "24px", height: "24px" }} />
    </div>
  );
}
