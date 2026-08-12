/**
 * Minimal ambient typing for the bundler-injected `import.meta.env` (CEL-1364).
 *
 * The package compiles with `tsc` (no bundler) and must not depend on
 * `vite/client`, so the two flags the DEV-only sign-in bypass reads are
 * declared here. This file is a `.d.ts` INPUT: `tsc` never emits it into
 * `dist`, so consumers keep their own `vite/client` declarations without a
 * duplicate-interface conflict.
 *
 * `import.meta.env.DEV` must be written out literally at the use site — Vite
 * statically replaces that exact expression with `true` / `false`, which is
 * what lets Rollup drop the DEV branch (and every module it references) from
 * production bundles. Aliasing it through a helper or optional chaining
 * defeats the replacement and ships the bypass to production.
 */
interface ImportMetaEnv {
  readonly DEV?: boolean;
  readonly PROD?: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
