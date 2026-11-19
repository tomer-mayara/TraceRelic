import { isAbsolute, resolve } from "node:path";
import type { GlobalConfigFile } from "./global-config-schema.ts";

export class GlobalConfig implements GlobalConfigFile {
  readonly codexPath: string;
  readonly claudePath?: string;

  constructor(codexPath: string, claudePath?: string) {
    this.codexPath = GlobalConfig.normalizePath("codexPath", codexPath);
    if (claudePath !== undefined) this.claudePath = GlobalConfig.normalizePath("claudePath", claudePath);
  }

  private static normalizePath(field: keyof GlobalConfigFile, path: string): string {
    if (!isAbsolute(path) || path.includes("\0")) {
      throw new Error(`${field} must be an absolute filesystem path without NUL characters`);
    }
    return resolve(path);
  }
}
