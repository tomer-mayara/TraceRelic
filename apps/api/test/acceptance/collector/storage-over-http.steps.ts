import { After, Before } from "@cucumber/cucumber";
import type { CollectorStorage } from "@tracerelic/collector/storage";
import { CollectorApiFixture } from "../../fixtures/collector-api-fixture.ts";

interface StorageScenario {
  api: CollectorApiFixture;
  store: CollectorStorage;
}

Before(async function (this: StorageScenario) {
  this.api = await CollectorApiFixture.open();
  this.store = this.api.a;
});
After(async function (this: StorageScenario) { await this.api?.close(); });
