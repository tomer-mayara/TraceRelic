import type { ClaudeUsageReport, Usage } from "../collector-storage.ts";
import type { OwnedReport } from "./claude-origin-reports.ts";

type Identity = Pick<ClaudeUsageReport, "messageId" | "requestId">;
type Iteration = Identity & Pick<ClaudeUsageReport, "iterationId" | "iterationPosition">;
type Request = { names: Map<string, string>; positions: Map<number, Set<string>>; ordinals: Map<string, Set<number>> };

/** Join an ordinal to a provider iteration only within an unambiguous provider request. */
export class ClaudeAdvisorIterations {
  readonly reports: OwnedReport[] = [];
  readonly unresolved: OwnedReport[] = [];
  private readonly requests = new Map<string, Request>();
  private readonly pairs = new Map<string, Set<string>>();

  constructor(rows: readonly OwnedReport[], published: readonly Usage[]) {
    for (const row of rows) if (row.messageId && row.requestId) {
      ClaudeAdvisorIterations.add(this.pairs, ClaudeAdvisorIterations.key({ messageId: row.messageId }), ClaudeAdvisorIterations.key(row));
      ClaudeAdvisorIterations.add(this.pairs, ClaudeAdvisorIterations.key({ requestId: row.requestId }), ClaudeAdvisorIterations.key(row));
    }
    for (const row of rows) {
      if (!row.iterationId) continue;
      const id = this.request(row);
      const request = this.requests.get(id) ?? { names: new Map(), positions: new Map(), ordinals: new Map() };
      this.requests.set(id, request);
      const index = ClaudeAdvisorIterations.position(row);
      if (index !== undefined && row.iterationId.startsWith("native:")) {
        ClaudeAdvisorIterations.add(request.positions, index, row.iterationId);
        ClaudeAdvisorIterations.add(request.ordinals, row.iterationId, index);
      }
    }
    for (const row of published) this.name(row);
    for (const row of rows) {
      const id = this.name(row);
      if (id === null) this.unresolved.push(row);
      else this.reports.push(id && id !== row.iterationId ? { ...row, iterationId: id } : row);
    }
  }

  private static key({ messageId, requestId }: Identity): string {
    return JSON.stringify([messageId, requestId]);
  }

  private static add<K, V>(map: Map<K, Set<V>>, k: K, value: V): void {
    const values = map.get(k) ?? new Set<V>();
    values.add(value);
    map.set(k, values);
  }

  private static position(report: Iteration): number | undefined {
    if (report.iterationPosition !== undefined) return report.iterationPosition;
    if (report.iterationId?.startsWith("index:")) {
      const value = Number(report.iterationId.slice(6));
      if (Number.isSafeInteger(value) && value >= 0) return value;
    }
  }

  private request(row: Identity): string {
    const id = ClaudeAdvisorIterations.key(row), pairs = this.pairs.get(id);
    return pairs?.size === 1 ? [...pairs][0] : id;
  }

  private name(row: Iteration): string | null | undefined {
    const request = this.requests.get(this.request(row));
    const reported = row.iterationId;
    const supplied = ClaudeAdvisorIterations.position(row);
    const ordinals = reported && request?.ordinals.get(reported);
    const index = supplied ?? (ordinals && ordinals.size === 1 ? [...ordinals][0] : undefined);
    const names = index === undefined ? undefined : request?.positions.get(index);
    if (!request || !reported || !names?.size) return reported;
    const [native] = names;
    if (names.size !== 1 || request.ordinals.get(native)?.size !== 1) {
      return reported.startsWith("index:") ? null : reported;
    }
    // Keep the ID and first time of the original publication in either arrival order.
    const first = request.names.get(native) ?? reported;
    request.names.set(native, first);
    return first;
  }

  published(row: Usage): Usage {
    if (!row.iterationId?.startsWith("index:")) return row;
    const request = this.requests.get(this.request(row));
    const candidates = request?.positions.get(Number(row.iterationId.slice(6)));
    if (candidates?.size !== 1) return row;
    const [native] = candidates;
    return request?.names.get(native) === row.iterationId ? { ...row, iterationId: native } : row;
  }
}
