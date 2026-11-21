import { mock } from "node:test";
import util, { type CallSiteObject } from "node:util";

export type CallerFrame = Pick<CallSiteObject, "scriptName" | "lineNumber">;

export class CallerStack {
  static during(frames: readonly CallerFrame[], report: () => void): void {
    const capture = mock.method(util, "getCallSites", () => frames);
    try {
      report();
    } finally {
      capture.mock.restore();
    }
  }
}
