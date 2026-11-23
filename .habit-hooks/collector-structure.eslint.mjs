import tsparser from "@typescript-eslint/parser";

// Each rule of the collector belongs to a class. No file of apps/collector/src declares a top-level function.
// The rule also applies to the two leaf modules of packages/shared that the collector layers share.
const files = [
  "apps/collector/src/**/*.ts",
  "packages/shared/src/claude-transcript-copy.ts",
  "packages/shared/src/recorded-instant.ts",
];

// The files that step 4 of the cleanup has not cleaned. The rule does not apply to them.
// Each task of step 4 removes its names. The list goes away at the end of step 4.
const pending = [
  // Task 4d
  "apps/collector/src/storage/batch-values.ts",
  "apps/collector/src/storage/checkpoint-transition.ts",
  "apps/collector/src/storage/claude/claude-advisor-iterations.ts",
  "apps/collector/src/storage/claude/claude-origin-reports.ts",
  "apps/collector/src/storage/claude/claude-owned-measurements.ts",
  "apps/collector/src/storage/claude/claude-report-evidence.ts",
  "apps/collector/src/storage/claude/claude-session-ownership.ts",
  "apps/collector/src/storage/claude/claude-usage-ledger.ts",
  "apps/collector/src/storage/codex/codex-call-aliases.ts",
  "apps/collector/src/storage/codex/codex-call-owners.ts",
  "apps/collector/src/storage/codex/codex-source-identity.ts",
  "apps/collector/src/storage/codex/observed-counter-spans.ts",
  "apps/collector/src/storage/codex/usage-windows.ts",
  "apps/collector/src/storage/http/http-collector-storage.ts",
  "apps/collector/src/storage/in-memory-collector-storage.ts",
  "apps/collector/src/storage/session-messages.ts",
  "apps/collector/src/storage/session-metadata.ts",
  "apps/collector/src/storage/session-usage.ts",
  "apps/collector/src/storage/source-inventory.ts",
];

const message =
  "Put this function in the class that owns the rule. See docs/specs/local-collector-structure-cleanup.md.";

const topLevelFunctions = [
  "Program > FunctionDeclaration",
  "Program > ExportNamedDeclaration > FunctionDeclaration",
  "Program > ExportDefaultDeclaration > FunctionDeclaration",
  "Program > VariableDeclaration > VariableDeclarator > ArrowFunctionExpression",
  "Program > VariableDeclaration > VariableDeclarator > FunctionExpression",
  "Program > ExportNamedDeclaration > VariableDeclaration > VariableDeclarator > ArrowFunctionExpression",
  "Program > ExportNamedDeclaration > VariableDeclaration > VariableDeclarator > FunctionExpression",
].map((selector) => ({ selector, message }));

export default [
  {
    files: files.map((file) => `**/${file}`),
    languageOptions: { parser: tsparser },
  },
  {
    files: files.map((file) => `**/${file}`),
    ignores: pending.map((file) => `**/${file}`),
    rules: {
      "no-restricted-syntax": ["error", ...topLevelFunctions],
    },
  },
];
