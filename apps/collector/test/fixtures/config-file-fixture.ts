import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

export class ConfigFileFixture {
  readonly file: string;
  readonly directory: string;

  private constructor(directory: string) {
    this.directory = directory;
    this.file = join(directory, "collector.json");
  }

  static async create(t: TestContext): Promise<ConfigFileFixture> {
    const directory = await mkdtemp(join(tmpdir(), "tracerelic-config-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    return new ConfigFileFixture(directory);
  }

  async write(contents: string): Promise<void> {
    await writeFile(this.file, contents);
  }
}
