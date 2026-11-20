import { isIPv4 } from "node:net";
import { matchesSourceScope, StorageAuthenticationError, StorageBackoffError, StorageUnavailableError,
  type AcknowledgedSource, type Batch, type CheckpointSnapshot, type CollectorStorage, type CommitResult,
  type PresenceWrite, type SessionKey, type SessionView, type SourceScope, type StreamKey } from "./collector-storage.ts";
import { CollectorWireContract } from "./collector-wire-contract.ts";

type Route = "session" | "checkpoint" | "sources" | "batches" | "presence";
type Transport = (url: URL, init: RequestInit) => Promise<Response>;
interface HttpOptions {
  fetch?: Transport;
  timeoutMs?: number;
  now?: () => number;
}

const invalidResponse = "Collector API returned an invalid response";
const writeStatus = { committed: 200, conflict: 409, invalid: 422 } satisfies Record<CommitResult, number>;

function apiOrigin(address: string): string {
  const url = URL.parse(address);
  if (url && url.href === url.origin + "/") {
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || (isIPv4(url.hostname) && url.hostname.startsWith("127."));
    if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) return url.origin;
  }
  throw new Error("Collector API URL must be an HTTPS origin or an HTTP loopback origin");
}

function httpDate(value: string, now: number): number | undefined {
  // RFC 9110 section 5.6.7 defines two older spellings and a 50-year cutoff for two-digit years.
  const rfc850 = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}:\d{2}:\d{2}) GMT$/.exec(value);
  const asctime = /^([A-Z][a-z]{2}) ([A-Z][a-z]{2}) ( \d|\d{2}) (\d{2}:\d{2}:\d{2}) (\d{4})$/.exec(value);
  let canonical = value;
  if (rfc850) {
    const [, weekday, day, month, shortYear, time] = rfc850;
    const cutoff = new Date(now);
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() + 50);
    let year = cutoff.getUTCFullYear() - (cutoff.getUTCFullYear() - Number(shortYear)) % 100;
    if (Date.parse(`${day} ${month} ${year} ${time} GMT`) > cutoff.getTime()) year -= 100;
    canonical = `${weekday.slice(0, 3)}, ${day} ${month} ${year} ${time} GMT`;
  } else if (asctime) {
    const [, weekday, month, day, time, year] = asctime;
    canonical = `${weekday}, ${day.replace(" ", "0")} ${month} ${year} ${time} GMT`;
  }
  if (canonical.length !== 29) return;
  const normalized = canonical.replace(" 23:59:60 GMT", " 23:59:59 GMT");
  const timestamp = Date.parse(normalized);
  if (new Date(timestamp).toUTCString() === normalized) return timestamp + (canonical !== normalized ? 1000 : 0);
}

function retryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return;
  if (/^\d+$/.test(value)) return Math.min(Number(value) * 1000, Number.MAX_SAFE_INTEGER);
  const timestamp = httpDate(value, now);
  return timestamp === undefined ? undefined : timestamp - now;
}

export class HttpCollectorStorage implements CollectorStorage {
  readonly #authorization: string;
  private readonly origin: string;
  private readonly transport: Transport;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly contract = new CollectorWireContract();

  constructor(apiUrl: string, token: string, options: HttpOptions = {}) {
    this.origin = apiOrigin(apiUrl);
    if (typeof token !== "string" || !/^[a-z0-9._~+/-]+=*$/i.test(token)) throw new StorageAuthenticationError();
    this.#authorization = "Bearer " + token;
    this.transport = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 2_147_483_647) {
      throw new Error("Collector API timeout must be a positive 32-bit integer in milliseconds");
    }
    this.now = options.now ?? Date.now;
  }

  async readSession({ harness, sessionId }: SessionKey): Promise<SessionView | null> {
    const { value } = await this.post("session", { harness, sessionId });
    if (!this.contract.is("SessionResult", value)) throw new Error(invalidResponse);
    const key = value.session?.key;
    if (key && (key.harness !== harness || key.sessionId !== sessionId)) throw new Error(invalidResponse);
    return value.session;
  }

  async readCheckpoint(source: StreamKey): Promise<CheckpointSnapshot> {
    const { value } = await this.post("checkpoint", source);
    if (!this.contract.is("CheckpointSnapshot", value)) throw new Error(invalidResponse);
    return value;
  }

  async listSources(scope: SourceScope): Promise<AcknowledgedSource[]> {
    const { value } = await this.post("sources", scope);
    if (!Array.isArray(value)) throw new Error(invalidResponse);
    return value.map((row: unknown) => {
      if (!this.contract.is("AcknowledgedSource", row)) throw new Error(invalidResponse);
      // Local discovery omits the installation field when the credential supplies it.
      if (scope.installationId === undefined) delete row.source.installationId;
      if (!matchesSourceScope(scope, row.source, row.location)) throw new Error(invalidResponse);
      return row;
    });
  }

  commit(batch: Batch): Promise<CommitResult> { return this.write("batches", batch); }
  recordPresence(update: PresenceWrite): Promise<CommitResult> { return this.write("presence", update); }

  private async write(route: "batches" | "presence", body: Batch | PresenceWrite): Promise<CommitResult> {
    const { status, value } = await this.post(route, body);
    if (status === 413) return "invalid";
    if (!value || typeof value !== "object" || !("result" in value)
        || !this.contract.is("CommitResult", value.result) || writeStatus[value.result] !== status) throw new Error(invalidResponse);
    return value.result;
  }

  private async post(route: Route, body: object): Promise<{ status: number; value: unknown }> {
    const request = {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs),
      headers: { authorization: this.#authorization, "content-type": "application/json" }, body: JSON.stringify(body),
    } satisfies RequestInit;
    let response: Response;
    try {
      response = await this.transport(new URL("/v1/collector/" + route, this.origin), request);
    } catch {
      throw new StorageUnavailableError("Collector API connection unavailable");
    }
    const { status } = response;
    const write = route === "batches" || route === "presence";
    if (status !== 200 && !(write && (status === 409 || status === 422))) {
      void response.body?.cancel().catch(() => {});
      if (route === "batches" && status === 413) return { status, value: undefined };
      if (status === 401 || status === 403) throw new StorageAuthenticationError();
      if (status === 408 || status === 429 || (status >= 500 && status < 600)) {
        throw new StorageBackoffError(retryAfter(response.headers.get("retry-after"), this.now()));
      }
      throw new Error("Collector API returned HTTP " + status);
    }
    try {
      return { status, value: await response.json() };
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(invalidResponse);
      throw new StorageUnavailableError("Collector API connection unavailable");
    }
  }
}
