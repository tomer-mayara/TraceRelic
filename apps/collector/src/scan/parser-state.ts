import { createHash } from "node:crypto";
import { ContractValues } from "../storage/collector-storage.ts";
import { JsonRecord } from "../transcript/json-record.ts";

export class TextOccurrences {
  private readonly counts = new Map<string, number>();

  static restore(state: unknown): TextOccurrences {
    const occurrences = new TextOccurrences();
    for (const [digest, count] of Object.entries(ParserState.record(state))) {
      if (!ContractValues.isDigest(digest) || !JsonRecord.isCount(count) || count < 1) {
        ParserState.invalid();
      }
      occurrences.counts.set(digest, count);
    }
    return occurrences;
  }

  identify(fields: readonly unknown[]): string {
    const digest = ParserState.digest(fields);
    const occurrence = (this.counts.get(digest) ?? 0) + 1;
    this.counts.set(digest, occurrence);
    return `text:${digest}:${occurrence}`;
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }
}

/** The digest of a JSON value, and the checks of a saved parser state. A parser state that is not correct causes an error. */
export class ParserState {
  static digest(value: string | readonly unknown[]): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }

  static record(value: unknown, fields?: readonly string[]): Record<string, unknown> {
    if (!JsonRecord.is(value)) ParserState.invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) ParserState.invalid();
    if (fields && Object.keys(value).some(key => !fields.includes(key))) ParserState.invalid();
    return value as Record<string, unknown>;
  }

  static string(value: unknown): string | undefined {
    if (value !== undefined && !JsonRecord.isNonemptyString(value)) ParserState.invalid();
    return value;
  }

  static invalid(): never {
    throw new Error("Invalid chat parser state");
  }
}
