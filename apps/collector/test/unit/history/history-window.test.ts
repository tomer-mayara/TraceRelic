import assert from "node:assert/strict";
import { test } from "node:test";
import { HistoryWindow } from "@tracerelic/collector/history";

const dates = { name: "RangeError", message: "Expected valid dates with fromDate at or before toDate" };
const instants = { name: "RangeError", message: "Expected valid instants with from at or before to" };

test("a date window contains its start and excludes its end", () => {
  const window = HistoryWindow.between(new Date("2026-02-01T00:00:00Z"), new Date("2026-02-02T00:00:00Z"));
  for (const inside of ["2026-02-01T00:00:00Z", "2026-02-01T00:00:00.000Z", "2026-01-31T19:00:00-05:00", "2026-02-01T23:59:59.999999999Z"]) {
    assert.equal(window.contains(inside), true, inside);
  }
  for (const outside of ["2026-01-31T23:59:59.999999Z", "2026-02-02T00:00:00Z", "2026-02-01T19:00:00-05:00", "2026-02-02T01:00:00+01:00"]) {
    assert.equal(window.contains(outside), false, outside);
  }
});

test("equal bounds contain no instant", () => {
  const at = new Date("2026-02-01T12:00:00.250Z");
  assert.equal(HistoryWindow.between(at, at).contains("2026-02-01T12:00:00.250Z"), false);
  const same = HistoryWindow.betweenInstants("2026-02-01T12:00:00.25Z", "2026-02-01T13:00:00.2500+01:00");
  assert.equal(same.contains("2026-02-01T12:00:00.25Z"), false);
});

test("rejects reversed and invalid bounds", () => {
  assert.throws(() => HistoryWindow.between(new Date(NaN), new Date("2026-02-02T00:00:00Z")), dates);
  assert.throws(() => HistoryWindow.between(new Date("2026-02-01T00:00:00Z"), new Date(NaN)), dates);
  assert.throws(() => HistoryWindow.between(new Date("2026-02-02T00:00:00Z"), new Date("2026-02-01T23:59:59.999Z")), dates);
  for (const [from, to] of [
    ["2026-02-01T00:00:00.0002Z", "2026-02-01T00:00:00.0001Z"],
    ["2026-02-01", "2026-02-02T00:00:00Z"],
    ["2026-02-01T00:00:00Z", "2026-02-02T00:00:00"],
    ["2026-02-30T00:00:00Z", "2026-03-01T00:00:00Z"],
    ["2026-02-01T00:00:00+0100", "2026-02-02T00:00:00Z"],
  ]) {
    assert.throws(() => HistoryWindow.betweenInstants(from, to), instants, `${from} to ${to}`);
  }
});

test("compares all fractional digits of instants beyond milliseconds", () => {
  const window = HistoryWindow.betweenInstants("2026-02-01T00:00:00.0001Z", "2026-02-01T00:00:00.000101Z");
  for (const inside of ["2026-02-01T00:00:00.0001Z", "2026-02-01T00:00:00.000100000Z", "2026-02-01T00:00:00.0001009Z"]) {
    assert.equal(window.contains(inside), true, inside);
  }
  for (const outside of ["2026-02-01T00:00:00.000101Z", "2026-02-01T00:00:00.0000999Z", "2026-02-01T00:00:00Z"]) {
    assert.equal(window.contains(outside), false, outside);
  }
});

test("contains no timestamp without a valid date, time and offset", () => {
  const window = HistoryWindow.between(new Date("2026-01-01T00:00:00Z"), new Date("2026-03-04T00:00:00Z"));
  for (const at of ["", "2026-01-32T12:00:00Z", "2026-02-01", "2026-02-01T12:00:00", "2026-01-31T24:00:00Z", "2026-02-30T12:00:00Z", "2026-02-01T12:00:00+0100"]) {
    assert.equal(window.contains(at), false, at);
  }
});

test("orders a leap second after every fraction of second 59", () => {
  const midnight = new Date("2017-01-01T00:00:00Z");
  assert.equal(HistoryWindow.between(new Date(midnight.getTime() - 1), midnight).contains("2017-01-01T00:59:60.125+01:00"), true);
  assert.equal(HistoryWindow.between(midnight, new Date(midnight.getTime() + 1)).contains("2016-12-31T23:59:60.5Z"), false);
});
