import { Writable } from "node:stream";
import type { TestContext } from "node:test";

export function replaceStderr(stream: Writable): () => void {
  const original = Object.getOwnPropertyDescriptor(process, "stderr");
  if (!original) throw new Error("Expected the test process to provide stderr");
  Object.defineProperty(process, "stderr", { configurable: true, value: stream });
  return () => { Object.defineProperty(process, "stderr", original); };
}

export class PendingStderr extends Writable {
  private finishWrite!: (error?: Error) => void;

  constructor(t: TestContext) {
    super();
    t.after(replaceStderr(this));
  }

  override _write(_chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error) => void): void {
    this.finishWrite = done;
  }

  release(error?: Error): void {
    this.finishWrite(error);
  }
}
