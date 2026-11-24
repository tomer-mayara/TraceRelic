import type { LocalHistoryEntry } from "../../history/index.ts";
import { isHistoryTimestamp } from "@tracerelic/shared";
import { JsonlRecords } from "../../transcript/jsonl-records.ts";

/** The native session ID, working directory and fork parent in a Codex session_meta record. */
export class CodexSessionHeader {
  static parse(record: LocalHistoryEntry["record"]) {
    if (record.type !== "session_meta" || !JsonlRecords.isRecord(record.payload)) return;
    const { id, session_id, cwd, source, timestamp } = record.payload;
    const sessionId = [id, session_id].find((value): value is string => typeof value === "string" && value.length > 0);
    if (!sessionId) return;
    const agent = JsonlRecords.isRecord(source) && JsonlRecords.isRecord(source.subagent) ? source.subagent.thread_spawn : undefined;
    const parentSessionId = [record.payload.forked_from_id, JsonlRecords.isRecord(agent) && agent.parent_thread_id,
      record.payload.forked_from_session_id, record.payload.forked_from, record.payload.parent_session_id, record.payload.parent_thread_id]
      .find((value): value is string => typeof value === "string" && value.length > 0);
    const at = timestamp ?? record.timestamp;
    const codexForkHeader = parentSessionId ? { parentSessionId, ...(isHistoryTimestamp(at) && { forkedAt: at }) } : undefined;
    return { sessionId, cwd, codexForkHeader };
  }
}
