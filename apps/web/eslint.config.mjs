import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // `NEXT_DIST_DIR` moves the build output, and the E2E environment sets it
    // to `.next-e2e` so its `next start` does not fight the deployed one.
    // `.gitignore` covers `.next-*/` but this list only knew about `.next`,
    // so `npm run lint` reported hundreds of errors in bundled vendor code on
    // any machine that had run the E2E build — and passed everywhere else.
    ".next-*/**",
    // Other gitignored build output that can land inside this workspace.
    "dist/**",
    "coverage/**",
    // Serwist writes these into `public/` on every build. They are
    // gitignored generated output, not source — linting them reported
    // errors in code nobody here wrote or can fix.
    "public/sw.js",
    "public/sw.js.map",
    "public/swe-worker-*.js",
  ]),
]);

export default eslintConfig;
