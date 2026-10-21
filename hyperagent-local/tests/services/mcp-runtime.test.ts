import { describe, expect, it } from "vitest";
import {
  formatAgentTools,
  probeStdioMcpServer,
} from "../../src/services/mcp-runtime.js";

describe("formatAgentTools", () => {
  it("returns null for empty input", () => {
    expect(formatAgentTools([])).toBeNull();
    expect(formatAgentTools(null)).toBeNull();
  });

  it("formats OpenAI-style and flat tool objects", () => {
    const section = formatAgentTools([
      { name: "search", description: "Search docs" },
      {
        type: "function",
        function: { name: "lookup", description: "Lookup a key" },
      },
      { nonsense: true },
    ]);
    expect(section).toContain("## Agent tools");
    expect(section).toContain("- search: Search docs");
    expect(section).toContain("- lookup: Lookup a key");
  });
});

describe("probeStdioMcpServer", () => {
  it("rejects missing command", async () => {
    const result = await probeStdioMcpServer("demo", {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/command/i);
  });

  it("lists tools from a tiny JSON-RPC echo server", async () => {
    // Node one-liner that answers initialize and tools/list over stdio lines.
    const script = `
      let buf = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\\n")) !== -1) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.method === "initialize") {
            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "echo", version: "0.0.1" },
              },
            }) + "\\n");
          } else if (msg.method === "tools/list") {
            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                tools: [
                  { name: "ping", description: "Return pong" },
                ],
              },
            }) + "\\n");
          }
        }
      });
    `;
    const result = await probeStdioMcpServer("echo", {
      command: process.execPath,
      args: ["-e", script],
    });
    expect(result.ok).toBe(true);
    expect(result.tools).toEqual([
      { name: "ping", description: "Return pong" },
    ]);
  });
});
