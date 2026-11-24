import type { CodexHistory, CodexRolloutEntry, CodexRolloutSource } from "./codex-history.ts";
import type { ScanSelection, SourceDiscoveryOptions } from "../../transcript/index.ts";
import type { Checkpoint, StreamKey } from "../../storage/collector-storage.ts";
import type { IdentityInventory, LocatedSource, ProviderScan } from "../../scan/scan-provider.ts";
import type { ParserFormat } from "../../scan/transcript-cursor.ts";
import { CodexForkSources } from "./codex-fork-sources.ts";
import { CodexIdentityRepair } from "./codex-identity-repair.ts";
import { CodexRolloutFiles } from "./codex-rollout-files.ts";

type Source = CodexRolloutSource;
type ScannedHistory = Pick<CodexHistory, "root" | "discoverSources" | "confirmedAbsent" | "identitiesAt">;

/** One Codex scan pass. Its state is the fork evidence of the latest discovery. */
export class CodexScan implements ProviderScan<CodexRolloutEntry, CodexRolloutSource> {
  private sources?: CodexForkSources;

  constructor(private readonly history: ScannedHistory, private readonly selection: ScanSelection) {}

  /** Each discovery replaces the fork evidence. The discovery of one changed file also reads the other selected
   * files, because a fork needs its selected parents as evidence. */
  discoverFiles(options: SourceDiscoveryOptions): AsyncIterable<readonly Source[]> {
    const related = options.sourceFile ? () => this.history.discoverSources(this.selection, { onChanged: options.onChanged }) : undefined;
    this.sources = new CodexForkSources(this.history.discoverSources(this.selection, options), related);
    return this.groups(this.sources.sources());
  }

  /** A plain rollout and its .zst form have the same name. */
  logicalName(sourceFile: string): string {
    return CodexRolloutFiles.logicalName(sourceFile);
  }

  parserFor(source: Source, checkpoint: Checkpoint | null): Promise<ParserFormat<CodexRolloutEntry>> {
    if (!this.sources) throw new Error("Discover the Codex files before you select a parser");
    return this.sources.format(source, checkpoint);
  }

  /** The path is the logical name. The root-based stream ID is the JSON array of the root and the path. */
  locate(source: Source): LocatedSource {
    const { root } = this.history;
    const { sourceFile, selectionCwd: cwd } = source;
    const path = CodexRolloutFiles.logicalName(sourceFile);
    const location = { root, path, ...(cwd && { cwd }) };
    return { location, rootStreamId: JSON.stringify([root, path]) };
  }

  confirmedAbsent(paths: readonly string[]): Promise<readonly string[]> {
    return this.history.confirmedAbsent(paths);
  }

  repairIdentities({ storage, scope, known, seen }: IdentityInventory<Source>): Promise<readonly StreamKey[]> {
    const repair = new CodexIdentityRepair(storage, scope);
    return repair.reconcile(known, seen, this.history.identitiesAt.bind(this.history));
  }

  /** Give each source as its own group, as soon as it is discovered. */
  private async *groups(sources: AsyncIterable<Source>): AsyncGenerator<Source[]> {
    for await (const source of sources) yield [source];
  }
}
