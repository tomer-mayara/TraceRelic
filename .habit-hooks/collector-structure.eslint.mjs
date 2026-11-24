import tsparser from "@typescript-eslint/parser";

// Directories of apps/collector/src where each rule belongs to a class.
// Add a directory when its cleanup step is complete.
const cleaned = ["history", "providers"];

// Parser files that step 2 moved into providers/ before their cleanup. The rule does not apply to them.
// Step 4a removes the Codex names. Step 4b removes the Claude Code names.
const pending = [
  "providers/claude/claude-chat.ts",
  "providers/claude/claude-source-copy.ts",
  "providers/claude/claude-usage-counts.ts",
  "providers/claude/claude-usage.ts",
  "providers/codex/codex-chat.ts",
  "providers/codex/codex-fork-evidence.ts",
  "providers/codex/codex-fork-sources.ts",
  "providers/codex/codex-token-counts.ts",
  "providers/codex/codex-usage-report.ts",
  "providers/codex/codex-usage.ts",
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
    files: cleaned.map((directory) => `**/apps/collector/src/${directory}/**/*.ts`),
    ignores: pending.map((file) => `**/apps/collector/src/${file}`),
    languageOptions: { parser: tsparser },
    rules: {
      "no-restricted-syntax": ["error", ...topLevelFunctions],
    },
  },
];
