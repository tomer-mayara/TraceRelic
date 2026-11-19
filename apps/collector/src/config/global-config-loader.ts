import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { globalConfigFileSchema, type GlobalConfigFile } from "./global-config-schema.ts";
import { GlobalConfig } from "./global-config.ts";

const isGlobalConfigFile = new Ajv2020({ ownProperties: true }).compile<GlobalConfigFile>(globalConfigFileSchema);

export class GlobalConfigLoader {
  static async load(filePath: string): Promise<GlobalConfig> {
    const filename = resolve(filePath);
    let contents: string;
    try {
      contents = await readFile(filename, "utf8");
    } catch (cause) {
      throw new Error(`Cannot read configuration file ${filename}`, { cause });
    }

    let config: unknown;
    try {
      config = JSON.parse(contents);
    } catch {
      throw new Error(`Invalid JSON in configuration file ${filename}`);
    }

    if (!isGlobalConfigFile(config)) {
      const issue = isGlobalConfigFile.errors?.[0];
      const field = Object.entries(globalConfigFileSchema.properties).find(([name]) => issue?.instancePath === `/${name}`);
      const reason = field
        ? `${field[0]} must be ${field[1].description}`
        : `expected a JSON object with ${globalConfigFileSchema.required.join(", ")}`;
      throw new Error(`Invalid configuration file ${filename}. ${reason}`);
    }

    const { codexPath } = config;
    const fromHome = codexPath === "~" || codexPath.startsWith("~/");
    const absolutePath = fromHome ? join(homedir(), codexPath.slice(2)) : resolve(dirname(filename), codexPath);
    return new GlobalConfig(absolutePath);
  }
}
