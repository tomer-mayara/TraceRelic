import type { LocalHistoryEntry } from "../../history/index.ts";
import { RecordedInstant } from "@tracerelic/shared";
import { JsonRecord } from "../../transcript/json-record.ts";

/** The native session ID, working directory and fork parent in a Codex session_meta record. */
export class CodexSessionHeader {
  static parse(record: LocalHistoryEntry["record"]) {
    if (record.type !== "session_meta" || !JsonRecord.is(record.payload)) return;
    const { id, session_id, cwd, source, timestamp } = record.payload;
    const sessionId = JsonRecord.identifier(id, session_id);
    if (!sessionId) return;
    const agent = JsonRecord.is(source) && JsonRecord.is(source.subagent) ? source.subagent.thread_spawn : undefined;
    const parentSessionId = JsonRecord.identifier(record.payload.forked_from_id, JsonRecord.is(agent) && agent.parent_thread_id,
      record.payload.forked_from_session_id, record.payload.forked_from, record.payload.parent_session_id, record.payload.parent_thread_id);
    const at = timestamp ?? record.timestamp;
    const codexForkHeader = parentSessionId ? { parentSessionId, ...(RecordedInstant.isTimestamp(at) && { forkedAt: at }) } : undefined;
    return { sessionId, cwd, codexForkHeader };
  }
}
