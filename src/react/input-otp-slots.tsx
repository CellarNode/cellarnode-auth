"use client";

import * as React from "react";
import { OTPInput, OTPInputContext } from "input-otp";
import { clsx } from "clsx";
import { MinusIcon } from "lucide-react";

export type InputOTPProps = React.ComponentProps<typeof OTPInput> & {
  containerClassName?: string;
};

export function InputOTP({ containerClassName, ...props }: InputOTPProps) {
  return (
    <OTPInput
      data-slot="input-otp"
      containerClassName={clsx(
        "flex items-center gap-2 has-disabled:opacity-50",
        containerClassName,
      )}
      {...props}
    />
  );
}

export function InputOTPGroup({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-otp-group"
      className={clsx("flex items-center", className)}
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
      data-active={isActive}
      className={clsx(
        "relative flex h-14 w-12 items-center justify-center rounded-lg border-2 border-border bg-background text-lg font-medium shadow-xs transition-all",
        isActive && "z-10 ring-[3px] ring-ring/50 border-primary",
        className,
      )}
      {...props}
    >
      {char}
      {hasFakeCaret && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="animate-caret-blink h-4 w-px bg-foreground duration-1000" />
        </div>
      )}
    </div>
  );
}

export function InputOTPSeparator(props: React.ComponentProps<"div">) {
  return (
    <div data-slot="input-otp-separator" role="separator" {...props}>
      <MinusIcon className="size-4" />
    </div>
  );
}
