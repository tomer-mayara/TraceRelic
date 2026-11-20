import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";

export type DropMoment = "before the API receives the upload" | "after the API accepts the upload";

/** Drop the scanner's socket before forwarding a batch, or after the real API responds. */
export class LoopbackUploadRelay {
  private readonly server = createServer((incoming, reply) => this.forward(incoming, reply));
  private nextDrop?: DropMoment;
  private offline = false;
  checkedWhileOffline = false;
  batches = 0;
  presenceWrites = 0;

  constructor(private readonly upstream: string) {}

  async listen(): Promise<string> {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address();
    assert(address && typeof address === "object");
    return `http://127.0.0.1:${address.port}`;
  }

  close(): Promise<void> { return this.server[Symbol.asyncDispose](); }
  dropNextBatch(moment: DropMoment): void { this.nextDrop = moment; }
  reconnect(): void { this.offline = false; }

  private forward(incoming: IncomingMessage, reply: ServerResponse): void {
    const path = incoming.url;
    const batch = path === "/v1/collector/batches";
    if (batch) this.batches++;
    if (this.offline) {
      if (path === "/v1/collector/checkpoint") this.checkedWhileOffline = true;
      reply.destroy();
      return;
    }
    let drop: DropMoment | undefined;
    if (batch) {
      drop = this.nextDrop;
      this.nextDrop = undefined;
      this.offline = drop !== undefined;
    }
    if (drop === "before the API receives the upload") {
      reply.destroy();
      return;
    }
    if (path === "/v1/collector/presence") this.presenceWrites++;
    const upstream = request(this.upstream + path, { method: incoming.method, headers: incoming.headers }, response => {
      if (drop === "after the API accepts the upload" && response.statusCode === 200) {
        response.resume();
        reply.destroy();
        return;
      }
      reply.writeHead(response.statusCode ?? 500, response.headers);
      response.pipe(reply);
    });
    upstream.on("error", error => reply.destroy(error));
    incoming.pipe(upstream);
  }
}
