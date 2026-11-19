import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { GlobalConfig, GlobalConfigLoader } from "@tracerelic/collector/config";
import { ConfigFileFixture } from "../../fixtures/config-file-fixture.ts";

test("loads independent configurations and resolves paths relative to each file", async t => {
  const first = await ConfigFileFixture.create(t);
  const second = await ConfigFileFixture.create(t);
  await first.write(JSON.stringify({ codexPath: "./providers/../codex", otherSetting: true }));
  const absolute = join(second.directory, "codex");
  await second.write(JSON.stringify({ codexPath: absolute }));

  const one = await GlobalConfigLoader.load(relative(process.cwd(), first.file));
  const two = await GlobalConfigLoader.load(second.file);

  assert.ok(one instanceof GlobalConfig && two instanceof GlobalConfig);
  assert.equal(one.codexPath, join(first.directory, "codex"));
  assert.equal(two.codexPath, absolute);
});

test("expands an explicit home directory or its child", async t => {
  const config = await ConfigFileFixture.create(t);
  for (const [input, expected] of [["~", homedir()], ["~/.codex", join(homedir(), ".codex")]]) {
    await config.write(JSON.stringify({ codexPath: input }));
    assert.equal((await GlobalConfigLoader.load(config.file)).codexPath, expected);
  }
});

test("identifies a missing or unreadable file and preserves the filesystem error", async t => {
  const config = await ConfigFileFixture.create(t);
  for (const file of [config.file, config.directory]) {
    await assert.rejects(GlobalConfigLoader.load(relative(process.cwd(), file)), (error: unknown) => {
      assert.ok(error instanceof Error && error.message.includes(file));
      assert.ok(error.cause instanceof Error && "code" in error.cause);
      return true;
    });
  }
});

test("reports the source of malformed JSON without exposing its content", async t => {
  const config = await ConfigFileFixture.create(t);
  await config.write("secret-config-value");
  await assert.rejects(GlobalConfigLoader.load(config.file), (error: unknown) => {
    assert.ok(error instanceof Error && error.message.includes(config.file));
    assert.doesNotMatch(error.message, /secret-config-value/);
    return true;
  });
});

test("rejects an invalid configuration object or codexPath", async t => {
  const config = await ConfigFileFixture.create(t);
  for (const value of [null, [], {}, { codexPath: 123 }, { codexPath: "bad\0path" }, { codexPath: "" }, { codexPath: " \t " }]) {
    await config.write(JSON.stringify(value));
    await assert.rejects(GlobalConfigLoader.load(config.file), (error: unknown) => {
      assert.ok(error instanceof Error && error.message.includes(config.file));
      assert.match(error.message, /codexPath/);
      return true;
    });
  }
});

test("resolves a relative filename before asynchronous I/O", async t => {
  const config = await ConfigFileFixture.create(t);
  await config.write(JSON.stringify({ codexPath: "provider" }));
  const original = process.cwd();
  const load = GlobalConfigLoader.load(relative(original, config.file));
  try {
    process.chdir(config.directory);
    assert.equal((await load).codexPath, join(config.directory, "provider"));
  } finally {
    process.chdir(original);
  }
});
