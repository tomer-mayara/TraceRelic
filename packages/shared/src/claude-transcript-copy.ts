/** Claude earlier copies can fill these session fields only while no source has supplied them. */
export const claudeCopyFallbackFields = ["cwd", "repository", "parentSessionId"] as const;

export function claudeCopyStem(filename: string): string | undefined {
  return (/^(.+)\.orphaned-\d.*-.+\.jsonl$/.exec(filename) ?? /^(.+)\.jsonl\.superseded-\d.*$/.exec(filename))?.[1];
}
