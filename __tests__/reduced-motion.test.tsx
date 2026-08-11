// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InputOTP } from "../src/react/input-otp-slots.js";
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

  return {
    OTPInput: ({ "data-shaking": dataShaking }: { readonly "data-shaking"?: boolean }) =>
      ReactModule.createElement("div", {
        "data-slot": "input-otp",
        "data-shaking": dataShaking || undefined,
      }),
    OTPInputContext: ReactModule.createContext({ slots: [] }),
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

  it("disables OTP root animation when motion is reduced", () => {
    // Given: the shared OTP input supplies its keyframe styles.
    const { container } = render(<InputOTP data-shaking maxLength={6} />);

    // When: the mounted input exposes its style sheet and invalid feedback surface.
    const styleSheet = container.querySelector("style")?.sheet;
    const reducedMotionRule = Array.from(styleSheet?.cssRules ?? []).find((rule) =>
      rule.cssText.includes("prefers-reduced-motion: reduce"),
    );
    const otpInput = container.querySelector("[data-slot='input-otp']");

    // Then: root shake plus every OTP descendant have animation and transition feedback disabled.
    expect(otpInput?.hasAttribute("data-shaking")).toBe(true);
    expect(reducedMotionRule?.cssText).toContain('[data-slot="input-otp-root"]');
    expect(reducedMotionRule?.cssText).toContain("animation: none !important;");
    expect(reducedMotionRule?.cssText).toContain("transition: none !important;");
  });
});
