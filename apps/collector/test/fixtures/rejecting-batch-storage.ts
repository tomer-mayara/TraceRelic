import type { Batch, CommitResult } from "../../src/storage/collector-storage.ts";
import { InMemoryCollectorStorage } from "./in-memory-collector-storage.ts";

export class RejectingBatchStorage extends InMemoryCollectorStorage {
  readonly attempts: Batch[] = [];

  constructor(private readonly reject: (batch: Batch) => boolean) {
    super();
  }

  override async commit(batch: Batch): Promise<CommitResult> {
    this.attempts.push(batch);
    return this.reject(batch) ? "invalid" : super.commit(batch);
  }
}
