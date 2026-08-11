// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "../src/react/input-otp-slots.js";
import { SquircleShift } from "../src/react/squircle-shift.js";

vi.mock("@react-three/fiber", () => ({
  Canvas: ({ frameloop }: { frameloop: string }) => (
    <output data-frameloop={frameloop} data-testid="shader-canvas" />
  ),
  useFrame: vi.fn(),
  useThree: vi.fn(),
}));

vi.mock("input-otp", async () => {
  const ReactModule = await import("react");
  const OTPInputContext = ReactModule.createContext({
    slots: [{ char: null, hasFakeCaret: true, isActive: false }],
  });

  return {
    OTPInput: ({
      children,
      "data-shaking": dataShaking,
    }: {
      readonly children?: React.ReactNode;
      readonly "data-shaking"?: boolean;
    }) =>
      ReactModule.createElement(
        OTPInputContext.Provider,
        { value: { slots: [{ char: null, hasFakeCaret: true, isActive: false }] } },
        ReactModule.createElement(
          ReactModule.Fragment,
          null,
          ReactModule.createElement("div", {
            "data-slot": "input-otp",
            "data-shaking": dataShaking || undefined,
          }),
          children,
        ),
      ),
    OTPInputContext,
  };
});

interface MatchMediaController {
  install(): void;
  setMatches(matches: boolean): void;
  listenerCount(): number;
  restore(): void;
}

function createMatchMediaController(initialMatches: boolean): MatchMediaController {
  let matches = initialMatches;
  const listeners = new Set<EventListener>();
  const originalMatchMedia = window.matchMedia;
  const mediaQuery = {
    get matches() {
      return matches;
    },
    addEventListener(type: string, listener: EventListener) {
      if (type === "change") listeners.add(listener);
    },
    removeEventListener(type: string, listener: EventListener) {
      if (type === "change") listeners.delete(listener);
    },
  };

  return {
    install() {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: () => mediaQuery,
      });
    },
    setMatches(nextMatches) {
      matches = nextMatches;
      for (const listener of listeners) listener(new Event("change"));
    },
    listenerCount() {
      return listeners.size;
    },
    restore() {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: originalMatchMedia,
      });
    },
  };
}

let matchMediaController: MatchMediaController | null = null;

afterEach(() => {
  cleanup();
  matchMediaController?.restore();
  matchMediaController = null;
});

describe("reduced-motion feedback (CEL-1395)", () => {
  it("changes the mounted SquircleShift frame loop with live motion preference", async () => {
    // Given: a user has asked the operating system to reduce motion.
    matchMediaController = createMatchMediaController(true);
    matchMediaController.install();
    const { unmount } = render(<SquircleShift />);

    // When: the operating system restores normal motion while the component is mounted.
    const canvas = screen.getByTestId("shader-canvas");
    await waitFor(() =>
      expect(canvas.getAttribute("data-frameloop")).toBe("demand"),
    );
    matchMediaController.setMatches(false);

    // Then: the live canvas resumes its continuous loop and removes its listener on unmount.
    await waitFor(() =>
      expect(canvas.getAttribute("data-frameloop")).toBe("always"),
    );
    unmount();
    expect(matchMediaController.listenerCount()).toBe(0);
  });

  it("covers root and sibling visual OTP animations when motion is reduced", () => {
    // Given: a shaking root with a sibling visual slot containing a fake caret.
    const { container } = render(
      <InputOTP data-shaking maxLength={1}>
        <InputOTPGroup>
          <InputOTPSlot index={0} />
        </InputOTPGroup>
      </InputOTP>,
    );

    // When: rendered animated elements are compared to the reduced-motion DOM selector.
    const styleSheet = container.querySelector("style")?.sheet;
    const reducedMotionStyleRule = Array.from(styleSheet?.cssRules ?? []).flatMap((rule) =>
      rule instanceof CSSMediaRule ? Array.from(rule.cssRules) : [],
    ).find(
      (rule): rule is CSSStyleRule =>
        rule instanceof CSSStyleRule && rule.style.animation === "none",
    );
    const root = container.querySelector<HTMLElement>("[data-slot='input-otp-root']");
    const animatedVisualElements = Array.from(root?.querySelectorAll<HTMLElement>("*") ?? [])
      .filter((element) => element.style.animation || element.style.transition);

    // Then: every normally animated root or visual sibling matches an animation-free selector.
    expect(root).not.toBeNull();
    expect(animatedVisualElements).not.toHaveLength(0);
    expect(reducedMotionStyleRule?.style.transition).toBe("none");
    expect([root, ...animatedVisualElements].every((element) =>
      element?.matches(reducedMotionStyleRule?.selectorText ?? ""),
    )).toBe(true);
  });
});
