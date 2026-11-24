import type { DecodedChat } from "#src/scan/decoded-chat";
import { planning } from "./collector-storage-fixture.ts";

export class ReplayOccurrencesFixture {
  static readonly repeated = "a".repeat(64);
  static readonly unique = "b".repeat(64);
  static readonly added = "c".repeat(64);

  static message(digest: string, occurrence: number, sourceOrder: number, blockIndex = 0) {
    return { ...planning, id: `text:${digest}:${occurrence}:${blockIndex}`, sourceOrder, blockIndex };
  }

  static chat(...messages: DecodedChat["messages"]): DecodedChat {
    return { messages, metadata: {} };
  }
}
