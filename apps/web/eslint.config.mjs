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
    // Serwist writes these into `public/` on every build. They are
    // gitignored generated output, not source — linting them reported
    // errors in code nobody here wrote or can fix.
    "public/sw.js",
    "public/sw.js.map",
    "public/swe-worker-*.js",
  ]),
]);

export default eslintConfig;
