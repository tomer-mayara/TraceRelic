import type { Batch, CodexCallClaim, Usage } from "./collector-storage.ts";
import { isIdentifier, isNativeCodexCall, isRecord } from "./usage-validation.ts";

type ParentLookup = (sessionId: string) => string | undefined;

/** Check the whole chain before using it. A cycle cannot establish an owner. */
function hasAncestor(child: string, ancestor: string, parentOf: ParentLookup): boolean {
  const visited = new Set([child]);
  let found = false;
  for (let next = parentOf(child); next !== undefined; next = parentOf(next)) {
    if (visited.has(next)) return false;
    visited.add(next);
    found ||= next === ancestor;
  }
  return found;
}

interface OwnershipUpdate {
  sessionId: string;
  bindings: SessionCallBindings;
  decisions: Map<string, Ownership>;
  transfers: Set<string>;
}

class SessionCallBindings {
  readonly providerIds = new Map<string, string>();
  private readonly usageIds = new Map<string, string>();

  private agrees({ usageId, providerId }: CodexCallClaim): boolean {
    return (this.providerIds.get(usageId) ?? providerId) === providerId
      && (this.usageIds.get(providerId) ?? usageId) === usageId;
  }

  bind(claim: CodexCallClaim, known?: SessionCallBindings): boolean {
    if (!this.agrees(claim) || (known && !known.agrees(claim))) return false;
    this.providerIds.set(claim.usageId, claim.providerId);
    this.usageIds.set(claim.providerId, claim.usageId);
    return true;
  }

  merge(additions: SessionCallBindings): void {
    for (const [usageId, providerId] of additions.providerIds) {
      this.providerIds.set(usageId, providerId);
      this.usageIds.set(providerId, usageId);
    }
  }
}

interface Ownership {
  owner: string;
  /** Several sessions can submit evidence for the same native call. */
  candidates?: ReadonlySet<string>;
}

/** The stored call IDs remain session-local. This index limits each native ID to one workspace owner. */
export class CodexCallOwners {
  private readonly decisions = new Map<string, Ownership>();
  private readonly contested = new Set<string>();
  private readonly bySession = new Map<string, SessionCallBindings>();

  visible(sessionId: string, usage: Usage[]): Usage[] {
    const bindings = this.bySession.get(sessionId);
    if (!bindings) return usage;
    return usage.filter(record => {
      const providerId = bindings.providerIds.get(record.id);
      return providerId === undefined || this.decisions.get(providerId)?.owner === sessionId;
    });
  }

  prepare(batch: Batch, stored: readonly Usage[], parentOf: ParentLookup, newProof: boolean): OwnershipUpdate | null | undefined {
    const claims = batch.codexCallClaims;
    if (claims !== undefined && (!Array.isArray(claims) || batch.source.harness !== "codex")) return null;
    if (!claims?.length && (!newProof || !this.contested.size)) return;
    const { sessionId } = batch.source;
    const known = this.bySession.get(sessionId);
    const update: OwnershipUpdate = { sessionId, bindings: new SessionCallBindings(), decisions: new Map(), transfers: new Set() };
    const calls = new Set([...stored, ...batch.usage, ...(batch.usageWindows ?? []).flatMap(window => window.parts)]
      .filter(isNativeCodexCall).map(record => record.id));
    for (const claim of claims ?? []) {
      if (!this.validClaim(batch, claim, calls, parentOf) || !update.bindings.bind(claim, known)) return null;
      this.recordCandidate(update.decisions, claim);
    }
    this.resolveTransfers(update, parentOf, newProof);
    return update;
  }

  private recordCandidate(decisions: Map<string, Ownership>, { providerId, ownerSessionId }: CodexCallClaim): void {
    const decision = decisions.get(providerId) ?? this.decisions.get(providerId);
    if (!decision) decisions.set(providerId, { owner: ownerSessionId });
    else if (decision.owner !== ownerSessionId) {
      const candidates = new Set(decision.candidates ?? [decision.owner]);
      candidates.add(ownerSessionId);
      decisions.set(providerId, { owner: decision.owner, candidates });
    }
  }

  private resolveTransfers(update: OwnershipUpdate, parentOf: ParentLookup, newProof: boolean): void {
    // A new parent match can resolve old claims even if neither stream has a new call.
    if (newProof) for (const id of this.contested) {
      const known = this.decisions.get(id);
      if (known && !update.decisions.has(id)) update.decisions.set(id, known);
    }
    for (const [id, decision] of update.decisions) {
      let owner = decision.owner;
      for (const candidate of decision.candidates ?? []) {
        if (candidate !== owner && hasAncestor(owner, candidate, parentOf)) owner = candidate;
      }
      if (owner !== decision.owner) {
        update.decisions.set(id, { ...decision, owner });
        update.transfers.add(decision.owner);
        update.transfers.add(owner);
      }
    }
  }

  private validClaim(batch: Batch, claim: CodexCallClaim, calls: ReadonlySet<string>, parentOf: ParentLookup): boolean {
    if (!isRecord(claim) || !isIdentifier(claim.ownerSessionId) || !isIdentifier(claim.usageId)
      || typeof claim.providerId !== "string" || !/^[a-f0-9]{64}$/.test(claim.providerId)) return false;
    if (claim.ownerSessionId === batch.source.sessionId) return calls.has(claim.usageId);
    const proof = batch.checkpoint.codexFork;
    return proof?.inheritedThrough !== undefined && claim.ownerSessionId === proof.parentSessionId
      && hasAncestor(batch.source.sessionId, claim.ownerSessionId, parentOf)
      && (calls.has(claim.usageId) || /^call:native:[a-f0-9]{64}$/.test(claim.usageId));
  }

  publish(update: OwnershipUpdate): void {
    const bindings = this.bySession.get(update.sessionId) ?? new SessionCallBindings();
    bindings.merge(update.bindings);
    this.bySession.set(update.sessionId, bindings);
    for (const [id, decision] of update.decisions) {
      this.decisions.set(id, decision);
      if (decision.candidates) this.contested.add(id);
    }
  }
}
