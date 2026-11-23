import type { GlobalConfigFile } from "../config/global-config-schema.ts";
import type { HistoryProvider } from "../history/index.ts";
import type { ScanProvider } from "../scan/scan-provider.ts";
import { ClaudeHistory } from "./claude/claude-history.ts";
import { CodexHistory } from "./codex/codex-history.ts";

/** A provider of local transcripts, for the reader and for the scanner. */
export type LocalProvider = HistoryProvider & ScanProvider;

/** Builds the providers of the configured roots. */
export class LocalProviders {
  /** Codex first, then Claude Code when the configuration has a claudePath. */
  static fromConfig(config: Pick<GlobalConfigFile, "codexPath" | "claudePath">): readonly LocalProvider[] {
    const providers: LocalProvider[] = [new CodexHistory(config.codexPath)];
    if (config.claudePath !== undefined) providers.push(new ClaudeHistory(config.claudePath));
    return providers;
  }
}
