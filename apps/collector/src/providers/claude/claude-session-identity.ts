import type { LocalHistoryEntry } from "../../history/index.ts";
import type { ClaudeSubagent } from "../../transcript/index.ts";

/** The session key of a Claude Code record: its native ID, or a subagent ID under the parent of its directory. */
export class ClaudeSessionIdentity {
  static parse(record: LocalHistoryEntry["record"], directory?: ClaudeSubagent): { sessionId: string; subagent?: ClaudeSubagent } | undefined {
    const nativeId = record.sessionId;
    if (typeof nativeId !== "string" || !nativeId.length) return;
    if (!directory) return { sessionId: nativeId };
    const { parentSessionId } = directory;
    const agentId = typeof record.agentId === "string" && record.agentId ? record.agentId : directory.agentId;
    if (nativeId === parentSessionId) {
      return { sessionId: `${encodeURIComponent(nativeId)}/subagents/${encodeURIComponent(agentId)}`, subagent: { parentSessionId, agentId } };
    }
    // A physical file may contain records from an independent session. A native
    // sidechain or agent ID links that session to this parent.
    const linked = record.isSidechain === true || record.agentId === directory.agentId || nativeId === directory.agentId;
    return { sessionId: nativeId, ...(linked && { subagent: { parentSessionId, agentId } }) };
  }
}
