import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import { RequestTrackingMcpServer } from "../../../src/server/RequestTrackingMcpServer.js";
import { runOrderedBatchCalls } from "../../../src/composition/batchSession.js";
import { createDeferred } from "../../fixtures/binarySession.js";

it("waits for a timed-out handler's finalization before continuing", async () => {
  const finalizing = createDeferred<void>();
  const release = createDeferred<void>();
  const server = new RequestTrackingMcpServer({
    name: "batch-order",
    version: "1",
  });
  const events: string[] = [];
  server.registerTool("slow", {}, async (context) => {
    await new Promise<void>((resolve) =>
      context.mcpReq.signal.addEventListener("abort", () => resolve(), {
        once: true,
      }),
    );
    finalizing.resolve();
    await release.promise;
    events.push("settled");
    return { content: [] };
  });
  server.registerTool("next", {}, () => {
    events.push("next");
    return { content: [] };
  });
  const client = new Client({ name: "batch-order", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const running = runOrderedBatchCalls({
      client,
      server,
      signal: new AbortController().signal,
      timeout: 100,
      continueOnError: true,
      calls: [
        { id: 1, tool: "slow", arguments: {} },
        { id: 2, tool: "next", arguments: {} },
      ],
      emit: async (record) => {
        events.push(`emit:${record.status}`);
      },
    });
    await finalizing.promise;
    expect(await server.drainRequests(0)).toBe(false);
    expect(events).toEqual([]);
    release.resolve();
    expect(await running).toBe(true);
    expect(events).toEqual(["settled", "emit:error", "next", "emit:ok"]);
  } finally {
    release.resolve();
    await client.close();
    await server.drainRequests();
    await server.close();
  }
});
