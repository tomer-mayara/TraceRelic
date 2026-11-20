import { ScanRecovery } from "#src/scan/scan-recovery";
import type { Checkpoint, CheckpointSnapshot, CommitResult } from "../../src/storage/collector-storage.ts";

export class ScanRecoveryFixture {
  reads = 0;
  commits = 0;
  readonly verified: number[][] = [];
  readonly saved = { offset: 10, prefixDigest: "digest-10", parserState: "old" };
  winner: CheckpointSnapshot = { checkpoint: this.saved, version: 2 };
  outcome: CommitResult | Error = "conflict";
  readonly recovery = new ScanRecovery({
    readCheckpoint: async () => {
      this.reads++;
      return this.winner;
    },
    commit: async () => {
      this.commits++;
      if (this.outcome instanceof Error) throw this.outcome;
      return this.outcome;
    },
    readSession: async () => { throw new Error("Unexpected session read"); },
  }, {
    fileSize: 100,
    prefixDigests: async offsets => {
      this.verified.push([...offsets]);
      return offsets.map(offset => ({ offset, prefixDigest: "digest-" + offset }));
    },
  });

  timeoutAfter(version: number, checkpoint: Checkpoint | null) {
    this.outcome = Object.assign(new Error("Write timed out"), { code: "ETIMEDOUT" });
    this.winner = { version, checkpoint };
  }
}
