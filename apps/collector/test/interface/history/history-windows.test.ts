import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { test } from "node:test";
import { HistoryWindowFixture } from "../../fixtures/history-window-fixture.ts";

const start = new Date("2026-02-01T00:00:00Z");
const end = new Date("2026-02-02T00:00:00Z");

for (const provider of ["Codex", "Claude Code"] as const) {
  test(`${provider} returns an empty list for an empty root or window`, async t => {
    const fixture = await HistoryWindowFixture.create(provider);
    t.after(() => fixture.close());
    const reader = fixture.reader();
    assert.deepEqual(await reader.readLocalHistory(start, end), []);

    const atEnd = fixture.message(end.toISOString(), "Next day");
    await fixture.write([atEnd]);
    assert.deepEqual(await reader.readLocalHistory(start, end), []);
    assert.deepEqual(await reader.readLocalHistory(end, end), []);
  });

  test(`${provider} rejects invalid or reversed date windows`, async t => {
    const fixture = await HistoryWindowFixture.create(provider);
    t.after(() => fixture.close());
    const reader = fixture.reader();
    const invalid = new Date(NaN);
    await assert.rejects(reader.readLocalHistory(invalid, end), RangeError);
    await assert.rejects(reader.readLocalHistory(start, invalid), RangeError);
    await assert.rejects(reader.readLocalHistory(end, start), RangeError);
  });

  test(`${provider} returns the final record once per read after its newline arrives`, async t => {
    const fixture = await HistoryWindowFixture.create(provider);
    t.after(() => fixture.close());
    const first = fixture.message("2026-02-01T12:00:00Z", "First in file");
    const final = fixture.message("2026-02-01T11:00:00Z", "Still writing");
    const file = await fixture.write([first]);
    await appendFile(file, JSON.stringify(final));
    const reader = fixture.reader();
    const readRecords = async () => (await reader.readLocalHistory(start, end)).map(entry => entry.record);
    assert.deepEqual(await readRecords(), [first]);

    await appendFile(file, "\n");
    assert.deepEqual(await readRecords(), [first, final]);
    assert.deepEqual(await readRecords(), [first, final]);
  });

  test(`${provider} reports the filesystem error for a regular file used as its root`, async t => {
    const fixture = await HistoryWindowFixture.create(provider);
    t.after(() => fixture.close());
    const file = await fixture.write([]);
    await assert.rejects(fixture.reader(file).readLocalHistory(start, end), { code: "ENOTDIR" });
  });
}
