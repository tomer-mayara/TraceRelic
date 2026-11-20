import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { StorageUnavailableError, type CollectorStorage, type CommitResult } from "@tracerelic/collector/storage";
import type { CollectorCredentials, CollectorScope } from "./collector-credentials.ts";
import { CollectorWireContract } from "@tracerelic/collector/wire-contract";
import { CollectorTransfers, MemoryWireState, type CollectorWireState } from "./collector-transfers.ts";

const routes = ["session", "checkpoint", "sources", "presence", "batches"] as const;
type Route = typeof routes[number];
const writeStatus = { committed: 200, conflict: 409, invalid: 422 } satisfies Record<CommitResult, number>;

export interface CommitMetric extends CollectorScope {
  operation: "commit";
  outcome: CommitResult | "storage-unavailable" | "internal-error";
  durationMs: number;
}

interface CollectorApiOptions {
  credentials: Pick<CollectorCredentials, "verify">;
  storageForWorkspace: (workspaceId: string) => CollectorStorage;
  onCommit?: (event: CommitMetric) => void;
  wireState?: CollectorWireState;
}

function authorization(request: FastifyRequest): string | undefined {
  const { rawHeaders } = request.raw;
  let value: string | undefined;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index].toLowerCase() !== "authorization") continue;
    if (value !== undefined) return;
    value = rawHeaders[index + 1];
  }
  return value;
}

function hasScopeOverride(value: unknown, installationId: string): boolean {
  if (!value || typeof value !== "object") return false;
  return "workspace" in value || "workspaceId" in value || ("installationId" in value && value.installationId !== installationId);
}

function writeResult(reply: FastifyReply, result: CommitResult) {
  return reply.code(writeStatus[result]).send({ result });
}

function problem(error: unknown): [number, string] {
  if (error instanceof Error && "code" in error) {
    switch (error.code) {
      case "FST_ERR_CTP_INVALID_JSON_BODY":
      case "FST_ERR_CTP_EMPTY_JSON_BODY":
      case "FST_ERR_CTP_INVALID_CONTENT_LENGTH": return [400, "bad-request"];
      case "FST_ERR_CTP_BODY_TOO_LARGE": return [413, "payload-too-large"];
      case "FST_ERR_CTP_INVALID_MEDIA_TYPE": return [415, "unsupported-media-type"];
    }
  }
  return StorageUnavailableError.is(error) ? [503, "storage-unavailable"] : [500, "internal-error"];
}

/** Version 1 collector operations share a verified scope for the lifetime of each request. */
export class CollectorApi {
  private readonly app = Fastify();
  private readonly contract = new CollectorWireContract();
  private readonly scopes = new WeakMap<FastifyRequest, CollectorScope>();
  private readonly transfers: CollectorTransfers;

  constructor(private readonly options: CollectorApiOptions) {
    this.transfers = new CollectorTransfers(options.wireState ?? new MemoryWireState(), this.contract);
    this.app.removeContentTypeParser("text/plain");
    this.app.addHook("onRequest", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const header = authorization(request);
      const scope = header && this.options.credentials.verify(header);
      if (!scope) return reply.header("WWW-Authenticate", "Bearer").code(401).send({ error: "unauthorized" });
      if (Number(request.headers["content-length"]) > request.routeOptions.bodyLimit) {
        // Drain the framed upload so a client still sending it can receive the HTTP response.
        request.raw.resume();
        return reply.code(413).send({ error: "payload-too-large" });
      }
      this.scopes.set(request, scope);
    });
    this.app.setErrorHandler((error, _request, reply) => {
      const [status, code] = problem(error);
      return reply.code(status).send({ error: code });
    });
    for (const route of routes) {
      this.app.post("/v1/collector/" + route, (request, reply) => this.handle(route, request, reply));
    }
  }

  listen(port = 0): Promise<string> { return this.app.listen({ host: "127.0.0.1", port }); }
  async close(): Promise<void> { await this.app.close(); }

  private async handle(route: Route, request: FastifyRequest, reply: FastifyReply) {
    const scope = this.scopes.get(request);
    if (!scope) throw new Error("Missing verified collector scope");
    const { installationId, workspaceId } = scope;
    const body = request.body;
    const source = body && typeof body === "object" && "source" in body ? body.source : undefined;
    if (body === undefined || hasScopeOverride(body, installationId) || hasScopeOverride(source, installationId)) {
      return reply.code(400).send({ error: "bad-request" });
    }
    const storage = () => this.options.storageForWorkspace(workspaceId);
    if (route === "batches") return this.commit(body, scope, reply);
    if (route === "presence") {
      if (!this.contract.is("PresenceWrite", body)) return writeResult(reply, "invalid");
      const store = storage();
      const source = await this.transfers.resolve(scope, body.source, store, body.location);
      let codexIdentity = body.codexIdentity;
      if (codexIdentity?.status === "verified") {
        const peer = await this.transfers.resolve(scope, { ...body.source, sessionId: codexIdentity.peerSessionId, streamId: codexIdentity.peerStreamId }, store);
        codexIdentity = { ...codexIdentity, peerStreamId: peer.streamId };
      }
      return writeResult(reply, await store.recordPresence({ ...body, source, ...(codexIdentity && { codexIdentity }) }));
    }
    if (route === "session" && this.contract.is("SessionKey", body)) {
      return { session: await this.transfers.session(scope, storage(), { harness: body.harness, sessionId: body.sessionId }) };
    }
    if (route === "checkpoint" && this.contract.is("StreamKey", body)) {
      return storage().readCheckpoint({ ...body, installationId });
    }
    if (route === "sources" && this.contract.is("SourceScope", body)) {
      const store = storage();
      return this.transfers.sources(store, await store.listSources({ ...body, installationId }));
    }
    return reply.code(400).send({ error: "bad-request" });
  }

  private async commit(body: unknown, scope: CollectorScope, reply: FastifyReply) {
    const { installationId, workspaceId } = scope;
    if (this.contract.is("BatchPart", body)) {
      const staged = await this.transfers.stage(scope, body);
      return staged ? reply.code(202).send({ result: "staged" }) : writeResult(reply, "invalid");
    }
    const start = performance.now();
    let outcome: CommitMetric["outcome"] = "internal-error";
    try {
      const packed = this.contract.is("PackedBatch", body) ? body : undefined;
      const decoded = packed ? await this.transfers.decode(scope, packed, this.options.storageForWorkspace(workspaceId)) : body;
      if (packed && (decoded === "invalid" || decoded === "conflict")) outcome = decoded;
      else if (this.contract.is("Batch", decoded)) {
        if (hasScopeOverride(decoded, installationId) || hasScopeOverride(decoded.source, installationId)) {
          outcome = "invalid";
          return reply.code(400).send({ error: "bad-request" });
        }
        const storage = this.options.storageForWorkspace(workspaceId);
        outcome = await storage.commit({ ...decoded, source: await this.transfers.resolve(scope, decoded.source, storage, decoded.sourceObservation?.location) });
      } else outcome = "invalid";
      if (packed?.parts && outcome === "committed") await this.transfers.state.discardParts(scope, packed.upload);
      return writeResult(reply, outcome);
    } catch (error) {
      outcome = StorageUnavailableError.is(error) ? "storage-unavailable" : "internal-error";
      throw error;
    } finally {
      this.report({ operation: "commit", workspaceId, installationId, outcome, durationMs: performance.now() - start });
    }
  }

  private report(event: CommitMetric): void {
    try {
      void Promise.resolve(this.options.onCommit?.(event)).catch(() => {});
    } catch {
      // A logging failure must preserve the storage outcome returned to the caller.
    }
  }
}
