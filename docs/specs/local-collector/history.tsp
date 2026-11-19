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
  /** Read complete records from the inclusive start to the exclusive end, in file order per source.
   * Invalid or reversed dates raise RangeError. File read errors propagate to the caller. */
  readLocalHistory(fromDate: utcDateTime, toDate: utcDateTime): LocalHistoryEntry[];
}
