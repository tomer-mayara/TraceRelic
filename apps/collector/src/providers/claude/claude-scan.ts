import { relative } from "node:path";
import type { ClaudeHistory, ClaudeTranscriptEntry, ClaudeTranscriptSource } from "../index.ts";
import type { ScanSelection, SourceDiscoveryOptions } from "../../transcript/index.ts";
import type { LocatedSource, ProviderScan } from "../../scan/scan-provider.ts";
import type { ParserFormat } from "../../scan/transcript-cursor.ts";
import { ClaudeSessionParser } from "./claude-session-parser.ts";
import { ClaudeEarlierCopies } from "./claude-source-copy.ts";

type Source = ClaudeTranscriptSource;
type ScannedHistory = Pick<ClaudeHistory, "root" | "discoverSources" | "confirmedAbsent" | "recoveryCandidates">;

/** One Claude Code scan pass. It has no identity repair and no logical name. */
export class ClaudeScan implements ProviderScan<ClaudeTranscriptEntry, ClaudeTranscriptSource> {
  readonly earlierCopies: ClaudeEarlierCopies;

  constructor(private readonly history: ScannedHistory, private readonly selection: ScanSelection) {
    this.earlierCopies = new ClaudeEarlierCopies(history);
  }

  async *discoverFiles(options: SourceDiscoveryOptions): AsyncGenerator<Source[]> {
    let group: Source[] = [];
    for await (const source of this.history.discoverSources(this.selection, options)) {
      // Claude discovery emits all the selected sessions in a physical file together.
      if (group.length && group[0].sourceFile !== source.sourceFile) {
        yield group;
        group = [];
      }
      group.push(source);
    }
    if (group.length) yield group;
  }

  parserFor(source: Source): ParserFormat<ClaudeTranscriptEntry> {
    return ClaudeSessionParser.forSource(source.previousCopy, source.claudeSubagent);
  }

  /** The path is relative to the root. The root-based stream ID is the absolute source file. */
  locate(source: Source): LocatedSource {
    const { root } = this.history;
    const { sourceFile, selectionCwd: cwd, projectDir, currentFileCwd } = source;
    const path = relative(root, sourceFile);
    const location = { root, path, ...(cwd && { cwd }), ...(projectDir && { projectDir }), ...(currentFileCwd && { currentFileCwd }) };
    return { location, rootStreamId: sourceFile };
  }

  /** Ignore the current-name alias of a copy only when its identity or accepted prefix has been disproved. */
  confirmedAbsent(paths: readonly string[], excludedCopyPaths?: readonly string[]): Promise<readonly string[]> {
    return this.history.confirmedAbsent(paths, excludedCopyPaths);
  }
}
