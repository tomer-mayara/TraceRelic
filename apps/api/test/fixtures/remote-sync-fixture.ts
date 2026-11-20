import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { InMemoryCollectorStorage } from "@tracerelic/collector/memory-storage";
import { LostConnectionFixture } from "#collector-fixture/lost-connection-fixture";
import { CollectorApi } from "#src/collector-api";
import { CollectorCredentials } from "#src/collector-credentials";
import { LoopbackStorage } from "./collector-api-fixture.ts";
import { credentialRecord } from "./collector-credential.ts";
import { LoopbackUploadRelay } from "./loopback-upload-relay.ts";

const cli = fileURLToPath(new URL("src/cli.ts", import.meta.resolve("@tracerelic/collector/package.json")));
interface ScanExit { code: number; stdout: string; stderr: string }

export class RemoteSyncFixture {
  private constructor(readonly upload: LostConnectionFixture, readonly relay: LoopbackUploadRelay,
    private readonly server: CollectorApi, private readonly address: string, private readonly token: string) {}

  static async open(): Promise<RemoteSyncFixture> {
    const token = randomUUID();
    const credentials = new CollectorCredentials([credentialRecord(token)]);
    const store = new InMemoryCollectorStorage();
    const server = new CollectorApi({ credentials, storageForWorkspace: () => store });
    const api = await server.listen();
    const relay = new LoopbackUploadRelay(api);
    try {
      const address = await relay.listen();
      const upload = await LostConnectionFixture.create({ storage: new LoopbackStorage(api, token) });
      return new RemoteSyncFixture(upload, relay, server, address, token);
    } catch (error) {
      await Promise.all([relay.close(), server.close()]);
      throw error;
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.relay.close(), this.server.close(), this.upload.close()]);
  }

  scan(config = this.upload.transcript.config): Promise<ScanExit> {
    const env = { ...process.env, TRACERELIC_COLLECTOR_API_URL: this.address, TRACERELIC_COLLECTOR_TOKEN: this.token };
    return new Promise((resolve, reject) => {
      execFile("bun", [cli, "scan", "--once", "--config", config], { env, timeout: 10_000 }, (error, stdout, stderr) => {
        const code = error ? error.code : 0;
        if (typeof code !== "number") { reject(error); return; }
        resolve({ code, stdout, stderr });
      });
    });
  }

  async scanAndRead(config?: string) {
    const result = await this.scan(config);
    assert.equal(result.code, 0, result.stderr);
    const { harness, sessionId } = this.upload.transcript.source;
    const accepted = await this.upload.storage.readSession({ harness, sessionId });
    assert(accepted, "the authenticated API must hold the session after the scanner exits");
    assert.deepEqual(JSON.parse(result.stdout), [accepted]);
    return accepted;
  }
}
