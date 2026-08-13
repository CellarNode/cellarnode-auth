import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { describe, expect, it } from "vitest";

/**
 * CEL-1364 — build-output proof that the DEV-only sign-in bypass leaves
 * production bundles.
 *
 * The behavioural tests in `login-form-dev-bypass.test.tsx` pin the RUNTIME
 * conditional: with `import.meta.env.DEV` stubbed false, nothing renders. That
 * is not the same claim. A refactor that reads the flag through an indirection
 * the bundler cannot fold statically would keep those tests green while
 * shipping the bypass UI to production.
 *
 * So this bundles `login-form.tsx` the way a consumer's Vite production build
 * does — `import.meta.env.DEV` statically defined to `false`, tree-shaking on —
 * and asserts the `DevSignInBypass` markup is absent from the emitted code,
 * while the same bundle built with DEV=true contains it. Building both
 * directions is what stops the assertion going inert if the sentinels drift.
 *
 * esbuild stands in for Rollup here: it applies the same `define` + DCE that
 * makes the elision work, and it is already installed as the transform half of
 * vitest's own toolchain.
 *
 * SCOPE — read before widening. Only the COMPONENT is statically eliminated.
 * `readDevLoginEmail` / `rememberDevLoginEmail` / `DEV_LOGIN_EMAIL_STORAGE_KEY`
 * are called from live function bodies behind runtime `if` guards, so they
 * survive into production bundles as unreachable code. That is a handful of
 * bytes and no behaviour (both are no-ops unless called), but it means the
 * storage-key literal is NOT a valid sentinel for this test.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Strings that exist only inside `DevSignInBypass`. */
const DEV_ONLY_MARKUP = ["Dev sign-in (skip the code)", "Development only"];

/** Peers a consumer app supplies; irrelevant to what we are measuring. */
const EXTERNALS = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "lucide-react",
  "input-otp",
  "clsx",
  "three",
  "@react-three/fiber",
];

async function bundleLoginForm(dev: boolean): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [`${ROOT}src/react/login-form.tsx`],
    bundle: true,
    write: false,
    format: "esm",
    treeShaking: true,
    jsx: "automatic",
    define: {
      "import.meta.env.DEV": String(dev),
      "import.meta.env.PROD": String(!dev),
    },
    external: EXTERNALS,
  });

  return result.outputFiles[0].text;
}

describe("dev sign-in bypass tree-shaking (CEL-1364)", () => {
  it("drops the bypass UI from a production bundle and keeps it in a dev one", async () => {
    const [prod, dev] = await Promise.all([
      bundleLoginForm(false),
      bundleLoginForm(true),
    ]);

    // Guards against a stale sentinel: if these strings ever stop existing, the
    // production assertion below would pass for the wrong reason.
    for (const marker of DEV_ONLY_MARKUP) {
      expect(dev, `DEV bundle should contain ${JSON.stringify(marker)}`).toContain(marker);
    }

    for (const marker of DEV_ONLY_MARKUP) {
      expect(prod, `PROD bundle must not contain ${JSON.stringify(marker)}`).not.toContain(marker);
    }
  }, 60_000);
});
