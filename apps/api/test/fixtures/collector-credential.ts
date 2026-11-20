import { createHash } from "node:crypto";

export function credentialRecord(token: string, workspaceId = "workspace-a", installationId = "desktop") {
  return { tokenSha256: createHash("sha256").update(token).digest("hex"),
    workspaceId, installationId, expiresAt: "2099-01-01T00:00:00Z" };
}
