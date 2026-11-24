import tsparser from "@typescript-eslint/parser";

// Each rule of the collector belongs to a class. No file of apps/collector/src declares a top-level function.
// The rule also applies to the two leaf modules of packages/shared that the collector layers share.
const files = [
  "apps/collector/src/**/*.ts",
  "packages/shared/src/claude-transcript-copy.ts",
  "packages/shared/src/recorded-instant.ts",
];

const message =
  "Put this function in the class that owns the rule. See docs/specs/local-collector-structure-cleanup.md.";

// A function, a function expression or an arrow function that is not in a class body.
const functionOutsideClass = { selector: ":function:not(ClassBody :function)", message };

export default [
  {
    files: files.map((file) => `**/${file}`),
    languageOptions: { parser: tsparser },
    rules: {
      "no-restricted-syntax": ["error", functionOutsideClass],
    },
  },
];
