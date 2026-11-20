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

alias RequestError = AuthenticationRequired
  | JsonReply<400, Problem<"bad-request">>
  | JsonReply<413, Problem<"payload-too-large">>
  | JsonReply<415, Problem<"unsupported-media-type">>
  | JsonReply<503, Problem<"storage-unavailable">>
  | JsonReply<500, Problem<"internal-error">>;

alias WriteReply = JsonReply<200, WriteResult<"committed">>
  | JsonReply<409, WriteResult<"conflict">>
  | JsonReply<422, WriteResult<"invalid">>
  | RequestError;

/** The credential selects the workspace. An absent session returns a null session. */
@post @route("/session")
op readSession(@body key: SessionKey): JsonReply<200, SessionResult> | RequestError;

/** Read the credential's installation checkpoint and the workspace session version. */
@post @route("/checkpoint")
op readCheckpoint(@body source: StreamKey): JsonReply<200, CheckpointSnapshot> | RequestError;

/** List sources for the credential's installation, root and selection. */
@post @route("/sources")
op listSources(@body scope: SourceScope): JsonReply<200, AcknowledgedSource[]> | RequestError;

/** Bind the batch source to the credential's installation before committing it. */
@post @route("/batches")
op commit(@body batch: Batch): WriteReply;

/** Apply a version-checked presence update to the credential's installation. */
@post @route("/presence")
op recordPresence(@body update: PresenceWrite): WriteReply;
