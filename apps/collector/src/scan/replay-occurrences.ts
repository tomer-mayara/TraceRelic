import type { Message } from "../storage/collector-storage.ts";
import { ParserState } from "./parser-state.ts";
import type { DecodedChat } from "./decoded-chat.ts";

export type ReplayOccurrences = Record<string, { accepted: number; replayed: number }>;

function fallbackId(id: string) {
  const match = /^text:([a-f0-9]{64}):([1-9][0-9]*):(0|[1-9][0-9]*)$/.exec(id);
  if (!match) return;
  const occurrence = Number(match[2]);
  if (Number.isSafeInteger(occurrence)) return { digest: match[1], occurrence, block: match[3] };
}

export function countReplayMessages(counts: Map<string, number>, messages: readonly Message[]): void {
  for (const message of messages) {
    const id = fallbackId(message.id);
    if (id) counts.set(id.digest, Math.max(counts.get(id.digest) ?? 0, id.occurrence));
  }
}

export function planReplayOccurrences(accepted: readonly Message[], replayed: ReadonlyMap<string, number>): ReplayOccurrences {
  const counts = new Map<string, number>();
  countReplayMessages(counts, accepted);
  const rules: ReplayOccurrences = {};
  for (const [digest, previous] of counts) {
    const current = replayed.get(digest) ?? 0;
    // A unique match can reuse its ID. A repeated fingerprint alone cannot identify an individual row.
    if (previous !== 1 || current !== 1) rules[digest] = { accepted: previous, replayed: current };
  }
  return rules;
}

export function reconcileReplayMessages(chat: DecodedChat, rules: ReplayOccurrences): void {
  const disputed = new Set<number>();
  chat.messages = chat.messages.flatMap(message => {
    const id = fallbackId(message.id);
    if (!id) return [message];
    const bounds = rules[id.digest];
    if (!bounds) return [message];
    if (id.occurrence <= bounds.replayed) {
      disputed.add(message.sourceOrder);
      return [];
    }
    // The replacement's occurrences were counted from zero. Subsequent appends start after the retained IDs.
    const occurrence = bounds.accepted + (id.occurrence - bounds.replayed);
    if (!Number.isSafeInteger(occurrence)) ParserState.invalid();
    return [{ ...message, id: `text:${id.digest}:${occurrence}:${id.block}` }];
  });
  if (disputed.size) {
    chat.hasGap = true;
    const diagnostics = chat.usageDiagnostics ??= [];
    for (const entry of diagnostics) if (entry.code === "ambiguous-transcript-replay") disputed.delete(entry.sourceOrder);
    for (const sourceOrder of disputed) diagnostics.push({ code: "ambiguous-transcript-replay", sourceOrder });
  }
}

export function readReplayOccurrences(value: unknown): ReplayOccurrences | undefined {
  if (value === undefined) return;
  const rules: ReplayOccurrences = {};
  for (const [digest, bounds] of Object.entries(ParserState.record(value))) {
    const { accepted, replayed } = ParserState.record(bounds, ["accepted", "replayed"]);
    if (!/^[a-f0-9]{64}$/.test(digest) || typeof accepted !== "number" || !Number.isSafeInteger(accepted) || accepted < 1
      || typeof replayed !== "number" || !Number.isSafeInteger(replayed) || replayed < 0) ParserState.invalid();
    rules[digest] = { accepted, replayed };
  }
  return rules;
}
