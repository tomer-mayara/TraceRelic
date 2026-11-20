import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";
import { GlobalConfig } from "@tracerelic/collector/config";

test("GlobalConfig stores a normalized absolute Codex path", () => {
  const root = tmpdir();
  assert.equal(new GlobalConfig(`${root}${sep}a${sep}..${sep}codex`).codexPath, join(root, "codex"));
});

test("GlobalConfig rejects empty, relative and NUL-containing paths", () => {
  for (const path of ["", "relative/codex", join(tmpdir(), "bad\0path")]) {
    assert.throws(() => new GlobalConfig(path), /codexPath/);
  }
});

test("GlobalConfig stores an optional normalized Claude path", () => {
  const root = tmpdir();
  assert.equal(new GlobalConfig(root).claudePath, undefined);
  assert.equal(new GlobalConfig(root, `${root}${sep}a${sep}..${sep}claude`).claudePath, join(root, "claude"));
  for (const path of ["", "relative/claude", join(root, "bad\0path")]) {
    assert.throws(() => new GlobalConfig(root, path), /claudePath/);
  }
});

test("GlobalConfig accepts a nonempty installation ID", () => {
  assert.equal(new GlobalConfig(tmpdir()).installationId, undefined);
  assert.equal(new GlobalConfig(tmpdir(), undefined, "laptop").installationId, "laptop");
  assert.throws(() => new GlobalConfig(tmpdir(), undefined, ""), /installationId/);
});
