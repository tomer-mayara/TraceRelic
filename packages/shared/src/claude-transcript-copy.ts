/** The name and the session fields of an earlier copy of a Claude Code transcript. */
export class ClaudeTranscriptCopy {
  /** Claude earlier copies can fill these session fields only while no source has supplied them. */
  static readonly fallbackFields = ["cwd", "repository", "parentSessionId"] as const;

  static stem(filename: string): string | undefined {
    return (/^(.+)\.orphaned-\d.*-.+\.jsonl$/.exec(filename) ?? /^(.+)\.jsonl\.superseded-\d.*$/.exec(filename))?.[1];
  }
}
