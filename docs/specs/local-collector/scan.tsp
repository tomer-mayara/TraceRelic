import "./storage.tsp";
import "./history.tsp";

namespace TraceRelic.Collector;

/** An empty selection includes the configured provider root. Otherwise a session
 * matches its native ID or the working directory in its session header.
 * Selecting a project directory also selects its descendants. */
model ScanSelection {
  sessionIds?: Identifier[];
  projectPaths?: string[];
}

model CodexRolloutEntry {
  ...PickProperties<LocalHistoryEntry, "sessionId" | "sourceFile" | "lineNumber" | "record">;
  ...OptionalProperties<PickProperties<LocalHistoryEntry, "timestamp">>;
  harness: "codex";
  /** Byte position immediately after this record's newline. */
  endOffset: Count;
}

model CodexRollout {
  ...PickProperties<CodexRolloutEntry, "sessionId" | "sourceFile" | "endOffset">;
  entries: CodexRolloutEntry[];
}

interface LocalLLMHistoryCodex extends LocalLLMHistory {
  /** Yield one selected rollout at a time. Preserve undated metadata and source order. */
  readRollouts(selection?: ScanSelection): CodexRollout[];
}

interface LocalCollector {
  /** Import complete records into the destination workspace. Return its selected sessions.
   * A rejected commit reports the source file and attempted byte range. */
  scanOnce(selection?: ScanSelection): SessionView[];
}
