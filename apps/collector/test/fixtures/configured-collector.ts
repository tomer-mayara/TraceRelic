import { LocalProviders } from "@tracerelic/collector/providers";
import { LocalCollector, type LocalCollectorOptions } from "@tracerelic/collector/scan";
import type { CollectorStorage } from "@tracerelic/collector/storage";

/** The configuration fields that select the providers and the stream IDs. */
interface CollectorConfig {
  readonly codexPath: string;
  readonly claudePath?: string;
  readonly installationId?: string;
}

/** Builds a collector for the providers of a configuration, as the command does. */
export class ConfiguredCollector {
  static from(
    config: CollectorConfig, storage: CollectorStorage, reports: Pick<LocalCollectorOptions, "onRejection" | "onMissing" | "progress"> = {},
  ): LocalCollector {
    return new LocalCollector({ providers: LocalProviders.fromConfig(config), storage, installationId: config.installationId, ...reports });
  }
}
