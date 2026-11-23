/** The checks that the readers and the parsers make on one decoded JSON value. */
export class JsonRecord {
  /** True for a JSON object. An array and null are not records. */
  static is(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  /** The value as a record, or undefined when it is not a JSON object. */
  static object(value: unknown): Readonly<Record<string, unknown>> | undefined {
    if (JsonRecord.is(value)) return value;
  }

  /** The first value that is a nonempty string. */
  static identifier(...values: unknown[]): string | undefined {
    return values.find((value): value is string => typeof value === "string" && value.length > 0);
  }

  /** True for a nonnegative safe integer. */
  static isCount(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  }
}
