import { setTimeout } from "node:timers/promises";
import type { AcknowledgedSource, SessionView } from "../../src/storage/collector-storage.ts";
import { inventoryLocation, inventorySource, measuredSource } from "./source-inventory-fixture.ts";

export const apiOrigin = "https://collector.example.test";
export const token = "fixture.opaque+token==";
export const sessionKey = { harness: inventorySource.harness, sessionId: inventorySource.sessionId };
export const session: SessionView = {
  key: sessionKey, metadata: {}, messages: [], usage: measuredSource().usage, coverage: "reported", observedTotalTokens: 70,
};
export const inventory: AcknowledgedSource = {
  source: inventorySource, location: inventoryLocation, observedEnd: 420, acceptedOffset: 420, version: 1, presence: "present",
};

export class CollectorHttpTransport {
  readonly requests: Request[] = [];
  respond: (request: Request) => Response | Promise<Response> = () => Response.json({ session: null });

  readonly fetch = async (url: URL, init: RequestInit): Promise<Response> => {
    const request = new Request(url, init);
    this.requests.push(request);
    return this.respond(request);
  };

  reply(status: number, body: unknown, headers?: HeadersInit): void {
    this.respond = () => Response.json(body, { status, headers });
  }

  stall(stage: "headers" | "body"): void {
    this.respond = async request => {
      const delay = setTimeout(2000, undefined, { signal: request.signal });
      if (stage === "headers") {
        await delay;
        return Response.json({ session: null });
      }
      return new Response(new ReadableStream({
        async start(controller) { await delay; controller.close(); },
      }));
    };
  }
}
