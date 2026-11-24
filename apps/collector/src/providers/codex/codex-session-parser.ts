import { isDeepStrictEqual } from "node:util";
import type { CodexRolloutEntry } from "./codex-history.ts";
import type { DamagedLine, RecordBatch } from "../../transcript/index.ts";
import type { CodexForkCheckpoint } from "../../storage/collector-storage.ts";
import { ParserState } from "../../scan/parser-state.ts";
import { CodexChat } from "./codex-chat.ts";
import { CodexForkUsage } from "./codex-fork-usage.ts";
import { CodexUsage } from "./codex-usage.ts";
import type { ChatParser, DecodedChat } from "../../scan/decoded-chat.ts";
import type { ParserFormat } from "../../scan/transcript-cursor.ts";

export class CodexSessionParser implements ChatParser<CodexRolloutEntry> {
  static readonly version = 2;
  static readonly gapVersion = 4;

  private constructor(private readonly chat: CodexChat, private readonly counts: CodexUsage, private readonly parentId?: string) {}

  static forFork(plan: CodexForkCheckpoint, forkedAt?: string): ParserFormat<CodexRolloutEntry> {
    const fork = () => new CodexForkUsage(plan, forkedAt);
    return {
      version: CodexSessionParser.version, gapVersion: CodexSessionParser.gapVersion, checkpointFields: { codexFork: plan },
      resume: state => CodexSessionParser.resume(state, fork()),
      upgrade: oldChat => CodexSessionParser.upgrade(oldChat, fork()),
      correction: checkpoint => {
        if (isDeepStrictEqual(plan, checkpoint.codexFork)) return;
        return {
          parentSessionId: plan.parentSessionId,
          accepted: (saved, parser, format) => {
            const acceptedChat = saved?.version === 1 ? saved.decoder : saved?.decoder.chat;
            const restored = acceptedChat ? format.resume({ ...parser.snapshot(), chat: acceptedChat }) : parser;
            return { parser: restored };
          },
          batchFields: { reconcileCodexForkFrom: checkpoint },
        };
      },
    };
  }

  static resume(state?: unknown, fork?: CodexForkUsage): CodexSessionParser {
    if (state === undefined) return new CodexSessionParser(CodexChat.resume(), CodexUsage.resume(undefined, fork), fork?.plan.parentSessionId);
    const saved = ParserState.record(state, ["chat", "usage"]);
    if (saved.chat === undefined || saved.usage === undefined) ParserState.invalid();
    return new CodexSessionParser(CodexChat.resume(saved.chat), CodexUsage.resume(saved.usage, fork), fork?.plan.parentSessionId);
  }

  static upgrade(oldChat?: object, fork?: CodexForkUsage) {
    const parser = new CodexSessionParser(CodexChat.resume(oldChat), CodexUsage.resume(undefined, fork), fork?.plan.parentSessionId);
    return {
      parser,
      read(entries: readonly CodexRolloutEntry[], damagedLines?: readonly DamagedLine[]) {
        // Version 1 already saved the chat state. Only the earlier empty checkpoint needs to reconstruct it.
        if (!oldChat) parser.chat.decodeBatch(entries, damagedLines);
        return parser.counts.decodeBatch(entries, damagedLines);
      },
    };
  }

  prepareLookahead(first: readonly CodexRolloutEntry[], tail: AsyncIterable<RecordBatch<CodexRolloutEntry>>, line: number, damage?: readonly DamagedLine[]): Promise<void> {
    return this.chat.prepareLookahead(first, tail, line, damage);
  }

  get awaitingBaseline(): boolean {
    return this.counts.awaitingBaseline;
  }

  decodeBatch(entries: readonly CodexRolloutEntry[], damagedLines?: readonly DamagedLine[]): DecodedChat {
    const chat = this.chat.decodeBatch(entries, damagedLines);
    if (this.parentId) chat.metadata.parentSessionId = this.parentId;
    return { ...chat, ...this.counts.decodeBatch(entries, damagedLines) };
  }

  snapshot(): object {
    return { chat: this.chat.snapshot(), usage: this.counts.snapshot() };
  }
}
