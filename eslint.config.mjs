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
    // Launch-video working directory: third-party minified vendor JS, not ours.
    "brag-output/**",
  ]),
  // Operational scripts and test harnesses are not app code. They run in
  // plain Node (so `require` is correct), and they poke at raw Firestore
  // documents where `any` is the honest type. app/ and lib/ stay strict.
  {
    files: ["scripts/**", "tests/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
    },
  },
]);

export default eslintConfig;
