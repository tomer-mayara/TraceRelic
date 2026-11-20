import "@typespec/http";
import "@typespec/openapi";
import "../local-collector/storage.tsp";

using TypeSpec.Http;
using TraceRelic.Collector;

/** Each bearer credential selects one workspace and installation. Omit the installation ID
 * or repeat the verified value. An explicit workspace selector or a different installation
 * on the request or its source receives HTTP 400. */
@service(#{ title: "TraceRelic collector storage" })
@TypeSpec.OpenAPI.info(#{ version: "1.0.0" })
@route("/v1/collector")
@useAuth(BearerAuth)
namespace TraceRelic.CollectorApi;

/** Environment settings used together by the collector's remote scan and watch commands. */
@TypeSpec.JsonSchema.jsonSchema
model CollectorRemoteDestination {
  /** HTTPS origin of the API. A loopback origin can also use HTTP. */
  @format("uri") TRACERELIC_COLLECTOR_API_URL: string;
  /** Opaque bearer credential issued to this installation. */
  @secret @pattern("^[a-zA-Z0-9._~+/-]+=*$") TRACERELIC_COLLECTOR_TOKEN: string;
}

/** Server environment setting for the PostgreSQL store. Startup applies outstanding migrations before listening. */
@TypeSpec.JsonSchema.jsonSchema
model CollectorDatabaseConfig {
  @secret @format("uri") @pattern("^postgres(ql)?://") DATABASE_URL: string;
}

@TypeSpec.JsonSchema.jsonSchema
model SessionResult {
  session: SessionView | null;
}

@pattern("^(?=[\\s\\S]*\\S)[^\\u0000-\\u001f\\u007f]+$")
scalar CredentialScopeId extends string;

/** A record in the server's trusted credential file. */
@TypeSpec.JsonSchema.jsonSchema
@TypeSpec.JsonSchema.extension("additionalProperties", false)
model CollectorCredentialRecord {
  @pattern("^[0-9a-f]{64}$")
  tokenSha256: string;
  workspaceId: CredentialScopeId;
  installationId: CredentialScopeId;
  @TypeSpec.JsonSchema.extension("pattern", "^[0-9-]{10}[Tt].*(?:[Zz]|[+-][0-9]{2}:[0-9]{2})$")
  expiresAt: utcDateTime;
}

@TypeSpec.JsonSchema.jsonSchema
model CollectorCredentialFile is CollectorCredentialRecord[];

/** One observation for an authenticated batch submitted to storage or rejected on validation. */
@TypeSpec.JsonSchema.jsonSchema
model CommitMetric {
  operation: "commit";
  workspaceId: Identifier;
  installationId: Identifier;
  outcome: CommitResult | "storage-unavailable" | "internal-error";
  @minValue(0) durationMs: float64;
}

model WriteResult<Result extends string> {
  result: Result;
}

model Problem<Code extends string> {
  error: Code;
}

model JsonReply<Status extends int32, Payload> {
  @statusCode status: Status;
  @header("Cache-Control") cacheControl: "no-store";
  @body body: Payload;
}

model AuthenticationRequired extends JsonReply<401, Problem<"unauthorized">> {
  @header("WWW-Authenticate") challenge: "Bearer";
}

/** An API or gateway can ask the client to wait a number of seconds or until an HTTP date. */
model RateLimited {
  @statusCode status: 429;
  @header("Retry-After") retryAfter?: string;
}

model ServiceUnavailable extends JsonReply<503, Problem<"storage-unavailable">> {
  @header("Retry-After") retryAfter?: string;
}

alias RequestError = AuthenticationRequired
  | RateLimited
  | JsonReply<400, Problem<"bad-request">>
  | JsonReply<413, Problem<"payload-too-large">>
  | JsonReply<415, Problem<"unsupported-media-type">>
  | ServiceUnavailable
  | JsonReply<500, Problem<"internal-error">>;

alias WriteReply = JsonReply<200, WriteResult<"committed">>
  | JsonReply<409, WriteResult<"conflict">>
  | JsonReply<422, WriteResult<"invalid">>
  | RequestError;

/** The credential selects the workspace. An absent session returns a null session. */
@post @route("/session")
op readSession(@body key: SessionKey): JsonReply<200, SessionResult> | RequestError;

/** Read the credential's installation checkpoint and the workspace session version. Both verified scanner keys address the same source. */
@post @route("/checkpoint")
op readCheckpoint(@body source: StreamKey): JsonReply<200, CheckpointSnapshot> | RequestError;

/** List sources for the credential's installation, root and selection. Fold scanner keys only when the recorded location, generation,
 * full checkpoint and current loss evidence agree. Preserve opaque IDs and divergent histories. */
@post @route("/sources")
op listSources(@body scope: SourceScope): JsonReply<200, AcknowledgedSource[]> | RequestError;

/** Commit the batch for the credential's installation. A stale session version or source offset
 * returns 409. A successful response acknowledges the records and checkpoint together.
 * Every request body is at most 1 MiB. Large batches use versioned literal bytes or copies from
 * the JSON-encoded accepted parser-state string. Retransmitted parts are idempotent and transferred under the same credential scope.
 * Uncommitted parts expire after one day. Only the final write changes collector data. */
@post @route("/batches")
op commit(@body batch: Batch | BatchPart | PackedBatch): WriteReply | JsonReply<202, WriteResult<"staged">>;

@TypeSpec.JsonSchema.jsonSchema
model BatchPart {
  transfer: "part-v1";
  upload: PrefixDigest;
  index: Count;
  /** Base64 of up to 512 KiB of the transfer. Repeating identical bytes is idempotent. */
  @maxLength(699052) data: string;
}

@TypeSpec.JsonSchema.jsonSchema
model PackedBatch {
  transfer: "commit-v1";
  source: StreamKey;
  expectedVersion: Count;
  /** SHA-256 of the complete encoded transfer. */
  upload: PrefixDigest;
  /** Number of authenticated, zero-based parts. Inline data contains the whole transfer instead. */
  parts?: PositiveCount;
  inline?: string;
  /** Original UTF-8 JSON size and digest, verified before storage receives the batch. */
  decodedBytes: PositiveCount;
  decodedSha256: PrefixDigest;
  /** With a base, the transfer is a JSON array of base64 literals or [offset,length] copy ranges. */
  base?: PrefixDigest;
}

/** Apply a version-checked presence update to the credential's installation. */
@post @route("/presence")
op recordPresence(@body update: PresenceWrite): WriteReply;
