import type { CapturedTranscriptFile } from "#src/transcript/captured-transcript-file";
import type { SelectedFile } from "#src/transcript/transcript-source";

export class TranscriptBatchesFixture {
  /** A selected Codex file of zero bytes. Its captured file has only the members that a read of zero bytes uses. */
  static emptyFile(): SelectedFile<"codex"> {
    const file = { sourceFile: "/mock/empty.jsonl", fileSize: 0, verifyPath: async () => {} };
    return {
      sessionId: "empty", file: file as unknown as CapturedTranscriptFile, harness: "codex",
      matches: () => true, isConversation: () => false,
    };
  }
}
