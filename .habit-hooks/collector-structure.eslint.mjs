import tsparser from "@typescript-eslint/parser";

// Directories of apps/collector/src where each rule belongs to a class.
// Add a directory when its cleanup step is complete.
const cleaned = ["history", "providers"];

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
    languageOptions: { parser: tsparser },
    rules: {
      "no-restricted-syntax": ["error", ...topLevelFunctions],
    },
  },
];
