import { type Fields, JsonRecord } from "../../transcript/json-record.ts";

/** The assistant message of a Claude Code record, as the usage parser accepts it. */
export class ClaudeAssistantRecord {
  static message(record: Fields): Fields | undefined {
    const message = record.message;
    if (record.type !== "assistant" || !JsonRecord.is(message) || (message.role !== undefined && message.role !== "assistant")) return;
    if (record.isMeta === true || record.isCompactSummary === true || message.model === "<synthetic>") return;
    return message;
  }
}
