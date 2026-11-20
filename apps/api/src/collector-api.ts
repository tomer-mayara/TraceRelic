import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { StorageUnavailableError, type CollectorStorage, type CommitResult } from "@tracerelic/collector/storage";
import type { CollectorCredentials, CollectorScope } from "./collector-credentials.ts";
import { CollectorWireContract } from "./collector-wire-contract.ts";

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

  constructor(private readonly options: CollectorApiOptions) {
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
      return writeResult(reply, await storage().recordPresence({ ...body, source: { ...body.source, installationId } }));
    }
    if (route === "session" && this.contract.is("SessionKey", body)) {
      return { session: await storage().readSession({ harness: body.harness, sessionId: body.sessionId }) };
    }
    if (route === "checkpoint" && this.contract.is("StreamKey", body)) {
      return storage().readCheckpoint({ ...body, installationId });
    }
    if (route === "sources" && this.contract.is("SourceScope", body)) {
      return storage().listSources({ ...body, installationId });
    }
    return reply.code(400).send({ error: "bad-request" });
  }

  private async commit(body: unknown, scope: CollectorScope, reply: FastifyReply) {
    const { installationId, workspaceId } = scope;
    const start = performance.now();
    let outcome: CommitMetric["outcome"] = "internal-error";
    try {
      outcome = this.contract.is("Batch", body)
        ? await this.options.storageForWorkspace(workspaceId).commit({ ...body, source: { ...body.source, installationId } })
        : "invalid";
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
