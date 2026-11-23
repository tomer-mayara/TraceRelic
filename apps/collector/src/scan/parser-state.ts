import { createHash } from "node:crypto";

export class TextOccurrences {
  private readonly counts = new Map<string, number>();

  static restore(state: unknown): TextOccurrences {
    const occurrences = new TextOccurrences();
    for (const [digest, count] of Object.entries(stateRecord(state))) {
      if (!/^[a-f0-9]{64}$/.test(digest) || typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) {
        invalidState();
      }
      occurrences.counts.set(digest, count);
    }
    return occurrences;
  }

  identify(fields: readonly unknown[]): string {
    const digest = jsonDigest(fields);
    const occurrence = (this.counts.get(digest) ?? 0) + 1;
    this.counts.set(digest, occurrence);
    return `text:${digest}:${occurrence}`;
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }
}

export function jsonDigest(value: string | readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function stateRecord(value: unknown, fields?: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidState();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) invalidState();
  if (fields && Object.keys(value).some(key => !fields.includes(key))) invalidState();
  return value as Record<string, unknown>;
}

export function stateString(value: unknown): string | undefined {
  if (value !== undefined && (typeof value !== "string" || !value.length)) invalidState();
  return value;
}

export function invalidState(): never {
  throw new Error("Invalid chat parser state");
}
