import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { LocalCollectorCliFixture } from "./local-collector-cli-fixture.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.resolve("@tracerelic/collector/package.json")));

export class RemoteCollectorCliFixture {
  private constructor(readonly config: string) {}

  static async create(t: TestContext): Promise<RemoteCollectorCliFixture> {
    const local = await LocalCollectorCliFixture.create();
    t.after(() => local.close());
    return new RemoteCollectorCliFixture(await local.writeConfig(".."));
  }

  async rejectCredentials(t: TestContext, status: number) {
    const authorizations: (string | undefined)[] = [];
    const server = createServer((request, response) => {
      authorizations.push(request.headers.authorization);
      response.writeHead(status).end("private response body");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    return { url: "http://127.0.0.1:" + (server.address() as AddressInfo).port, authorizations };
  }

  async run(args: string[], apiUrl?: string, token?: string, runtime: "bun" | "node" = "bun") {
    const env = { ...process.env, TRACERELIC_COLLECTOR_API_URL: apiUrl, TRACERELIC_COLLECTOR_TOKEN: token };
    const entry = runtime === "bun" ? "apps/collector/src/cli.ts" : "apps/collector/dist/cli.js";
    const child = spawn(runtime, [entry, "--config", this.config, ...args], {
      cwd: repoRoot, env, timeout: 5000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const [code] = await once(child, "close");
    return { code, stdout, stderr };
  }
}
