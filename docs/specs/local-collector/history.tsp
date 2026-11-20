import "@typespec/json-schema";
import "./config.tsp";
import "./session-key.tsp";
using TypeSpec.JsonSchema;

@jsonSchema
namespace TraceRelic.Collector;

/** Claude records use their native session ID. A subagent that repeats its
 * parent's ID uses <parent>/subagents/<agent>, with each ID percent-encoded. */
model LocalHistoryEntry extends SessionKey {
  /** Absolute path of the transcript at the time of the read. */
  @minLength(1) sourceFile: string;
  /** One-based line number in that file. */
  @minValue(1) lineNumber: safeint;
  /** The timestamp string as recorded, including its UTC offset. */
  @format("date-time")
  @pattern("^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt].*([Zz]|[+-][0-9]{2}:[0-9]{2})$")
  timestamp: string;
  /** The complete parsed provider object, including fields unknown to TraceRelic. */
  record: Record<unknown>;
}

interface LocalLLMHistory {
  /** Read each source anew, in file order, from the inclusive start to the exclusive end.
   * Equal endpoints return an empty list. A final record becomes readable after its newline.
   * Invalid or reversed dates raise RangeError. File read errors propagate to the caller. */
  readLocalHistory(fromDate: utcDateTime, toDate: utcDateTime): LocalHistoryEntry[];
  /** Read the same window from RFC 3339 strings, retaining all recorded fractional digits.
   * A Codex rollout stored as .jsonl.zst has the same logical bytes as its plain form.
   * For same-name plain and compressed copies with the same native ID, return the longer
   * verified byte prefix. Prefer plain on a tie. Read divergent files independently. */
  readLocalHistoryInstants(from: string, to: string): LocalHistoryEntry[];
}
