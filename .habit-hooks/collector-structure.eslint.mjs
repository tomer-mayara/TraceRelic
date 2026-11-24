import tsparser from "@typescript-eslint/parser";

// Each rule of the collector belongs to a class. These selectors keep that structure.
// The source rules apply to all of apps/collector/src and to the two leaf modules of packages/shared
// that the collector layers share.
const sourceFiles = [
  "apps/collector/src/**/*.ts",
  "packages/shared/src/claude-transcript-copy.ts",
  "packages/shared/src/recorded-instant.ts",
];

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

export default [
  {
    files: sourceFiles.map((file) => `**/${file}`),
    languageOptions: { parser: tsparser },
    rules: {
      "no-restricted-syntax": ["error", functionOutsideClass, thisInStaticMethod],
    },
  },
];
