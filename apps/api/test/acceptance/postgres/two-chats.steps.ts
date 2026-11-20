import { After, Before } from "@cucumber/cucumber";
import type { CollectorStorage } from "@tracerelic/collector/storage";
import { DurableApiFixture } from "../../fixtures/durable-api-fixture.ts";

interface TwoChatsScenario {
  api: DurableApiFixture;
  scanStorage: CollectorStorage;
  sessionReader: CollectorStorage;
}

Before({ tags: "@two_chats", timeout: 120_000 }, async function (this: TwoChatsScenario) {
  this.api = await DurableApiFixture.open();
  this.scanStorage = (await this.api.start()).a;
  this.sessionReader = (await this.api.start()).a;
});

After({ tags: "@two_chats", timeout: 30_000 }, async function (this: TwoChatsScenario) {
  await this.api?.close();
});
