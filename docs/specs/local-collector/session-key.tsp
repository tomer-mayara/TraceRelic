import "@typespec/json-schema";
using TypeSpec.JsonSchema;

@jsonSchema
namespace TraceRelic.Collector;

@minLength(1)
scalar Identifier extends string;

union Harness { "codex", "claude" }

model SessionKey {
  harness: Harness;
  sessionId: Identifier;
}
