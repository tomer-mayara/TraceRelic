import { PassThrough } from "node:stream";
import type { TestContext } from "node:test";

export class ColorTerminal extends PassThrough {
  readonly isTTY = true;

  constructor(t: TestContext, colorSettings: NodeJS.ProcessEnv = {}) {
    super();
    this.setEncoding("utf8");
    const stderr = Object.getOwnPropertyDescriptor(process, "stderr")!;
    Object.defineProperty(process, "stderr", { configurable: true, value: this });
    const env = process.env;
    process.env = { ...env, TERM: "xterm-256color" };
    for (const key of ["CI", "FORCE_COLOR", "NO_COLOR", "NODE_DISABLE_COLORS"]) delete process.env[key];
    Object.assign(process.env, colorSettings);
    t.after(() => {
      process.env = env;
      Object.defineProperty(process, "stderr", stderr);
    });
  }
}
