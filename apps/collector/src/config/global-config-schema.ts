import type { JSONSchemaType } from "ajv/dist/2020.js";

export interface GlobalConfigFile {
  readonly codexPath: string;
  readonly claudePath?: string;
}

const pathSchema = {
  type: "string",
  description: "a nonblank filesystem path without NUL characters",
  pattern: "^(?=[\\s\\S]*\\S)[^\\u0000]+$",
} as const;

// Ajv types optional fields as nullable. Check each present value as a string
// and use the required list to control which fields may be omitted.
export const globalConfigFileSchema = {
  type: "object",
  required: ["codexPath"],
  properties: {
    codexPath: pathSchema,
    claudePath: pathSchema,
  },
  additionalProperties: true,
} as const satisfies JSONSchemaType<Required<GlobalConfigFile>>;
