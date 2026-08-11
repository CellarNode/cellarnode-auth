import { describe, expect, it } from "vitest";
import {
  getShaderTime,
  getSquircleFrameloop,
  STATIC_SHADER_TIME,
} from "../src/react/squircle-shift.js";
import { OTP_STYLES } from "../src/react/input-otp-slots.js";

describe("reduced-motion feedback (CEL-1395)", () => {
  it("renders a static SquircleShift frame when motion is reduced", () => {
    // Given: a user has asked the operating system to reduce motion.
    const prefersReducedMotion = true;

    // When: the shader render policy is selected.
    const frameloop = getSquircleFrameloop(prefersReducedMotion);
    const shaderTime = getShaderTime(12.5, prefersReducedMotion);

    // Then: R3F renders on demand with a deterministic, static shader frame.
    expect(frameloop).toBe("demand");
    expect(shaderTime).toBe(STATIC_SHADER_TIME);
  });

  it("keeps SquircleShift continuous for users without reduced motion", () => {
    // Given: a user has not asked the operating system to reduce motion.
    const prefersReducedMotion = false;

    // When: the shader render policy is selected.
    const frameloop = getSquircleFrameloop(prefersReducedMotion);
    const shaderTime = getShaderTime(12.5, prefersReducedMotion);

    // Then: the existing animation loop and elapsed shader time are retained.
    expect(frameloop).toBe("always");
    expect(shaderTime).toBe(12.5);
  });

  it("removes OTP scale, shake, and blink feedback when motion is reduced", () => {
    // Given: the shared OTP input supplies its keyframe styles.
    const styles = OTP_STYLES;

    // When: a consumer's system preference requests reduced motion.
    const reducedMotionStyles = styles.match(
      /@media \(prefers-reduced-motion: reduce\) \{(?<rules>[\s\S]*?)\n  \}/,
    );

    // Then: every OTP descendant has its animation and transition feedback disabled.
    expect(reducedMotionStyles?.groups?.rules).toContain("animation: none !important;");
    expect(reducedMotionStyles?.groups?.rules).toContain("transition: none !important;");
  });
});
