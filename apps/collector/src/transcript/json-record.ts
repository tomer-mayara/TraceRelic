/** The checks that the readers and the parsers make on one decoded JSON value. */
export class JsonRecord {
  /** True for a JSON object. An array and null are not records. */
  static is(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  /** The value as a record, or undefined when it is not a JSON object. */
  static object(value: unknown): Fields | undefined {
    if (JsonRecord.is(value)) return value;
  }

  /** True for a string that has one character or more. */
  static isNonemptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
  }

  /** The first value that is a nonempty string. */
  static identifier(...values: unknown[]): string | undefined {
    return values.find(JsonRecord.isNonemptyString);
  }

  /** True for a nonnegative safe integer. */
  static isCount(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  }
}

/** The fields of one decoded JSON object. The code that reads them does not change them. */
export type Fields = Readonly<Record<string, unknown>>;
