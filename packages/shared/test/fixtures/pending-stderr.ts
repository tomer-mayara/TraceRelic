import { Writable } from "node:stream";
import type { TestContext } from "node:test";

export class PendingStderr extends Writable {
  private finishWrite!: () => void;

  constructor(t: TestContext) {
    super();
    t.mock.method(process.stderr, "write", this.write.bind(this));
    t.mock.method(process.stderr, "end", this.end.bind(this));
  }

  override _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    this.finishWrite = done;
  }

  release(): void {
    this.finishWrite();
  }
}
