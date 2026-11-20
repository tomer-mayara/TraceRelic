import { posix, win32 } from "node:path";

/** An absolute path carries its own dialect even when the collector or API runs on another OS. */
export function recordedPathDialect(value: unknown): typeof posix | undefined {
  if (typeof value !== "string" || value.includes("\0")) return;
  if (/^[a-z]:[/\\]/i.test(value) || /^[/\\]{2}[^/\\]+[/\\][^/\\]+(?:[/\\]|$)/.test(value)) return win32;
  if (value.startsWith("/")) return posix;
}

export function matchesRecordedPath(root: string, candidate: unknown, exact = false): boolean {
  const dialect = recordedPathDialect(root);
  if (!dialect || typeof candidate !== "string" || recordedPathDialect(candidate) !== dialect) return false;
  const path = dialect.relative(root, candidate);
  return path === "" || (!exact && !dialect.isAbsolute(path) && path !== ".." && !path.startsWith(".." + dialect.sep));
}
