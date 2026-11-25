import tsparser from "@typescript-eslint/parser";

// Each rule of the collector belongs to a class. These selectors keep that structure.
// The function rule applies to all of apps/collector/src and to the two leaf modules of packages/shared
// that the collector layers share. The static method rule also applies to apps/api/src and to all of
// packages/shared/src. The test rule applies to the tests of the three workspaces.
const functionFiles = [
  "apps/collector/src/**/*.ts",
  "packages/shared/src/claude-transcript-copy.ts",
  "packages/shared/src/recorded-instant.ts",
];
const staticMethodFiles = ["apps/api/src/**/*.ts", "packages/shared/src/**/*.ts"];
const testFiles = ["apps/collector/test/**/*.ts", "apps/api/test/**/*.ts", "packages/shared/test/**/*.ts"];

const plan = "See docs/specs/local-collector-structure-cleanup.md.";

// A function, a function expression or an arrow function that is not in a class body.
const functionOutsideClass = {
  selector: ":function:not(ClassBody :function)",
  message: `Put this function in the class that owns the rule. ${plan}`,
};

// `this` in a static method, also in a function that is in that method.
// A static method that a caller passes as a value has no `this`.
const thisInStaticMethod = {
  selector: "MethodDefinition[static=true] ThisExpression",
  message: `Name the class in a static method. Do not use \`this\`. ${plan}`,
};

// An import, a re-export, a dynamic import or an import type whose module is ../src.
const relativeSourceImport = {
  selector:
    ":matches(ImportDeclaration, ExportNamedDeclaration, ExportAllDeclaration, ImportExpression, TSImportType)[source.value=/^(\\.\\.\\/)+src\\//]",
  message: `Do not import ../src in a test. Use a package export, or #src/… where the package has that map. ${plan}`,
};

const block = (files, ...selectors) => ({
  files: files.map((file) => `**/${file}`),
  languageOptions: { parser: tsparser },
  rules: { "no-restricted-syntax": ["error", ...selectors] },
});

// For a file that two blocks match, the later block replaces the rule of the earlier block.
// Thus the block with both source rules comes after the block with the static method rule alone.
export default [
  block(staticMethodFiles, thisInStaticMethod),
  block(functionFiles, functionOutsideClass, thisInStaticMethod),
  block(testFiles, relativeSourceImport),
];
