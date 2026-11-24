import type { CodexRolloutEntry, CodexRolloutSource } from "./codex-history.ts";
import type { Checkpoint, CodexForkCheckpoint } from "../../storage/collector-storage.ts";
import { CodexForkEvidence } from "./codex-fork-evidence.ts";
import { CodexSessionParser } from "./codex-session-parser.ts";
import type { ParserFormat } from "../../scan/transcript-cursor.ts";

type Source = CodexRolloutSource;

function strongestBoundary(previous: CodexForkCheckpoint | undefined, current: Awaited<ReturnType<CodexForkEvidence["assess"]>>) {
  const before = previous?.inheritedThrough, after = current?.fork.inheritedThrough;
  if (before && !current?.contradicted && (!after || after.offset < before.offset)) return previous;
  return current?.fork;
}

/** Keep ordinary scans streaming. A fork also needs the headers of later selected files. */
export class CodexForkSources {
  private evidence?: CodexForkEvidence;
  private readonly selected = new Set<string>();
  private readonly decisions = new WeakMap<Source, ReturnType<CodexForkEvidence["assess"]>>();

  constructor(private readonly discovery: AsyncGenerator<Source>, private readonly related?: () => AsyncGenerator<Source>) {}

  async *sources(): AsyncGenerator<Source> {
    const earlier: Source[] = [];
    for await (const source of this.discovery) {
      if (source.codexForkHeader) {
        const remaining = [source, ...await Array.fromAsync(this.discovery)];
        const all = earlier.concat(remaining);
        await this.addRelated(all);
        for (const item of all) this.selected.add(item.sessionId);
        this.evidence = new CodexForkEvidence(all);
        yield* remaining;
        return;
      }
      earlier.push(source);
      yield source;
    }
  }

  private async addRelated(all: Source[]): Promise<void> {
    if (!this.related) return;
    // Rediscovering a single changed child still needs the selected parents as evidence.
    const paths = new Set(all.map(item => item.sourceFile));
    for await (const related of this.related()) if (!paths.has(related.sourceFile)) all.push(related);
  }

  async format(source: Source, checkpoint: Checkpoint | null): Promise<ParserFormat<CodexRolloutEntry>> {
    const header = source.codexForkHeader;
    if (!header || !this.evidence) return CodexSessionParser;
    const saved = checkpoint?.codexFork?.parentSessionId === header.parentSessionId ? checkpoint.codexFork : undefined;
    const boundary = saved?.inheritedThrough;
    const acceptedOffset = checkpoint?.offset ?? 0;
    // The caller has verified the accepted bytes and any copied prefix beyond them.
    const verified = boundary && (boundary.prefixDigest || boundary.offset <= acceptedOffset);
    const acceptedDispute = saved?.firstUncertain && saved.firstUncertain.offset < acceptedOffset;
    if (saved && (acceptedDispute || verified) && !this.selected.has(header.parentSessionId)) {
      return CodexSessionParser.forFork(saved, header.forkedAt);
    }
    let decision = this.decisions.get(source);
    if (!decision) {
      decision = this.resolve(source, this.evidence);
      this.decisions.set(source, decision);
    }
    const current = await decision;
    // Missing evidence preserves an accepted boundary. A changed provider identity can revoke it.
    const plan = strongestBoundary(verified ? saved : undefined, current);
    return plan ? CodexSessionParser.forFork(plan, header.forkedAt) : CodexSessionParser;
  }

  private async resolve(source: Source, evidence: CodexForkEvidence) {
    const assessment = await evidence.assess(source);
    const boundary = assessment?.fork.inheritedThrough;
    if (!assessment || !boundary) return assessment;
    const [proof] = await source.prefixDigests([boundary.offset]);
    return { ...assessment, fork: { ...assessment.fork, inheritedThrough: { ...boundary, prefixDigest: proof.prefixDigest } } };
  }
}
