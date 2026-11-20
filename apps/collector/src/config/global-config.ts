import { isAbsolute, resolve } from "node:path";
import type { GlobalConfigFile } from "./global-config-schema.ts";

export class GlobalConfig implements GlobalConfigFile {
  readonly codexPath: string;
  readonly claudePath?: string;
  readonly installationId?: string;

  constructor(codexPath: string, claudePath?: string, installationId?: string) {
    this.codexPath = GlobalConfig.normalizePath("codexPath", codexPath);
    if (claudePath !== undefined) this.claudePath = GlobalConfig.normalizePath("claudePath", claudePath);
    if (installationId !== undefined) {
      if (typeof installationId !== "string" || !installationId.length) throw new Error("installationId must be a nonempty string");
      this.installationId = installationId;
    }
  }

  private static normalizePath(field: "codexPath" | "claudePath", path: string): string {
    if (!isAbsolute(path) || path.includes("\0")) {
      throw new Error(`${field} must be an absolute filesystem path without NUL characters`);
    }
    return resolve(path);
  }
}
