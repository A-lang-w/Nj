import { createServer, type IncomingMessage, type Server } from "node:http";
import { describe, expect, it, afterEach } from "vitest";
import {
  callSseMcpTool,
  callStreamableHttpMcpTool,
  consumeSseFrames,
  probeSseMcpServer,
  probeStreamableHttpMcpServer,
} from "../../src/services/mcp-http.js";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr == null || typeof addr === "string") {
    throw new Error("expected TCP address");
  }
  return addr.port;
}

describe("consumeSseFrames", () => {
  it("parses event and data frames and keeps a partial trailer", () => {
    const events: Array<{ event: string; data: string }> = [];
    const rest = consumeSseFrames(
      'event: endpoint\ndata: /msg\n\ndata: {"id":1}\n\ndata: partial',
      (e) => events.push(e),
    );
    expect(events).toEqual([
      { event: "endpoint", data: "/msg" },
      { event: "message", data: '{"id":1}' },
    ]);
    expect(rest).toBe("data: partial");
  });
});

describe("SSE MCP transport", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("probes tools/list over HTTP+SSE", async () => {
    let sseOut: import("node:http").ServerResponse | null = null;
    server = createServer((req, res) => {
      void (async () => {
        if (req.method === "GET" && req.url === "/sse") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          const port = (server!.address() as { port: number }).port;
          res.write(
            `event: endpoint\ndata: http://127.0.0.1:${port}/message\n\n`,
          );
          sseOut = res;
          return;
        }
        if (req.method === "POST" && req.url === "/message") {
          const raw = await readBody(req);
          const msg = JSON.parse(raw) as {
            id?: number;
            method?: string;
          };
          res.writeHead(202);
          res.end();
          if (msg.method === "initialize" && sseOut) {
            sseOut.write(
              `event: message\ndata: ${JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  protocolVersion: "2024-11-05",
                  capabilities: { tools: {} },
                  serverInfo: { name: "sse-demo", version: "0.0.1" },
                },
              })}\n\n`,
            );
          } else if (msg.method === "tools/list" && sseOut) {
            sseOut.write(
              `event: message\ndata: ${JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  tools: [{ name: "echo", description: "Echo input" }],
                },
              })}\n\n`,
            );
          } else if (msg.method === "tools/call" && sseOut) {
            sseOut.write(
              `event: message\ndata: ${JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  content: [{ type: "text", text: "pong" }],
                },
              })}\n\n`,
            );
          }
          return;
        }
        res.writeHead(404);
        res.end();
      })().catch(() => {
        res.writeHead(500);
        res.end();
      });
    });

    const port = await listen(server);
    const result = await probeSseMcpServer("sse-demo", {
      url: `http://127.0.0.1:${port}/sse`,
    });
    expect(result.ok).toBe(true);
    expect(result.tools).toEqual([
      { name: "echo", description: "Echo input", inputSchema: undefined },
    ]);

    const called = await callSseMcpTool(
      { url: `http://127.0.0.1:${port}/sse` },
      "echo",
      { text: "hi" },
    );
    expect(called).toEqual({ ok: true, text: "pong" });
  });

  it("rejects missing url", async () => {
    const result = await probeSseMcpServer("x", {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/url/i);
  });
});

describe("streamable-http MCP transport", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("probes tools/list over streamable HTTP JSON", async () => {
    server = createServer((req, res) => {
      void (async () => {
        if (req.method !== "POST" || req.url !== "/mcp") {
          res.writeHead(404);
          res.end();
          return;
        }
        const raw = await readBody(req);
        const msg = JSON.parse(raw) as { id?: number; method?: string };
        if (msg.method === "initialize") {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Mcp-Session-Id": "sess-1",
          });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "http-demo", version: "0.0.1" },
              },
            }),
          );
          return;
        }
        if (msg.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }
        if (msg.method === "tools/list") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                tools: [{ name: "ping", description: "Ping" }],
              },
            }),
          );
          return;
        }
        if (msg.method === "tools/call") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { content: [{ type: "text", text: "ok" }] },
            }),
          );
          return;
        }
        res.writeHead(400);
        res.end();
      })().catch(() => {
        res.writeHead(500);
        res.end();
      });
    });

    const port = await listen(server);
    const result = await probeStreamableHttpMcpServer("http-demo", {
      url: `http://127.0.0.1:${port}/mcp`,
    });
    expect(result.ok).toBe(true);
    expect(result.tools).toEqual([
      { name: "ping", description: "Ping", inputSchema: undefined },
    ]);

    const called = await callStreamableHttpMcpTool(
      { url: `http://127.0.0.1:${port}/mcp` },
      "ping",
      {},
    );
    expect(called).toEqual({ ok: true, text: "ok" });
  });
});
