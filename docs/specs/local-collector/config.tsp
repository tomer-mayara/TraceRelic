import "@typespec/json-schema";
using TypeSpec.JsonSchema;

@jsonSchema
namespace TraceRelic.Collector;

model GlobalConfig {
  /** Codex provider root. Relative paths start at the config file's directory.
   * A leading ~/ selects the current user's home directory. */
  @pattern("^(?=[\\s\\S]*\\S)[^\\u0000]+$")
  codexPath: string;
}

interface GlobalConfigLoader {
  /** Load one JSON file and return absolute paths. An unreadable or invalid
   * file reports its path and prevents the collector from starting. */
  load(filePath: string): GlobalConfig;
}
