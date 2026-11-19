import { isAbsolute, resolve } from "node:path";
import type { GlobalConfigFile } from "./global-config-schema.ts";

export class GlobalConfig implements GlobalConfigFile {
  readonly codexPath: string;

  constructor(codexPath: string) {
    if (!isAbsolute(codexPath) || codexPath.includes("\0")) {
      throw new Error("codexPath must be an absolute filesystem path without NUL characters");
    }
    this.codexPath = resolve(codexPath);
  }
}
