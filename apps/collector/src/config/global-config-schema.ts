import type { JSONSchemaType } from "ajv/dist/2020.js";

export interface GlobalConfigFile {
  readonly codexPath: string;
}

export const globalConfigFileSchema = {
  type: "object",
  required: ["codexPath"],
  properties: {
    codexPath: {
      type: "string",
      description: "a nonblank filesystem path without NUL characters",
      pattern: "^(?=[\\s\\S]*\\S)[^\\u0000]+$",
    },
  },
  additionalProperties: true,
} as const satisfies JSONSchemaType<GlobalConfigFile>;
