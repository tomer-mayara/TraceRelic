import { After, Before } from "@cucumber/cucumber";
import type { CollectorStorage } from "@tracerelic/collector/storage";
import { DurableApiFixture } from "../../fixtures/durable-api-fixture.ts";

interface StorageScenario {
  api: DurableApiFixture;
  store: CollectorStorage;
}

Before({ timeout: 120_000 }, async function (this: StorageScenario) {
  this.api = await DurableApiFixture.open();
  this.store = (await this.api.start()).a;
});
After({ timeout: 30_000 }, async function (this: StorageScenario) { await this.api?.close(); });
