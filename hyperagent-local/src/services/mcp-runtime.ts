import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { logger } from "../lib/logger.js";

export interface McpToolSummary {
  name: string;
  description?: string;
}

export interface McpServerProbeResult {
  serverName: string;
  transportType: string;
  ok: boolean;
  tools: McpToolSummary[];
  error?: string;
}

interface StdioConfig {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  cwd?: unknown;
}

const PROBE_TIMEOUT_MS = 8_000;
const MAX_TOOLS = 40;

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function asEnv(value: unknown): NodeJS.ProcessEnv | undefined {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string") out[key] = raw;
  }
  return out;
}

/**
 * Best-effort MCP tools/list probe for a stdio server. Bounded by timeout;
 * failures return an error string instead of throwing so chat can continue.
 */
export async function probeStdioMcpServer(
  serverName: string,
  config: Record<string, unknown>,
): Promise<McpServerProbeResult> {
  const cfg = config as StdioConfig;
  const command = typeof cfg.command === "string" ? cfg.command.trim() : "";
  if (!command) {
    return {
      serverName,
      transportType: "stdio",
      ok: false,
      tools: [],
      error: "config.command is required for stdio transport",
    };
  }
  const args = asStringArray(cfg.args);
  const cwd = typeof cfg.cwd === "string" ? cfg.cwd : undefined;
  const env = asEnv(cfg.env);

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result: McpServerProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGTERM");
      } catch {
        // process may already have exited
      }
      resolve(result);
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        serverName,
        transportType: "stdio",
        ok: false,
        tools: [],
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const timer = setTimeout(() => {
      finish({
        serverName,
        transportType: "stdio",
        ok: false,
        tools: [],
        error: `probe timed out after ${PROBE_TIMEOUT_MS}ms`,
      });
    }, PROBE_TIMEOUT_MS);

    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      // Process complete JSON-RPC lines as they arrive.
      let newline = stdout.indexOf("\n");
      while (newline !== -1) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        newline = stdout.indexOf("\n");
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as {
            id?: unknown;
            result?: {
              tools?: Array<{ name?: unknown; description?: unknown }>;
            };
            error?: { message?: unknown };
          };
          if (msg.id === 2 && msg.error) {
            finish({
              serverName,
              transportType: "stdio",
              ok: false,
              tools: [],
              error:
                typeof msg.error.message === "string"
                  ? msg.error.message
                  : "tools/list failed",
            });
            return;
          }
          if (msg.id === 2 && msg.result?.tools) {
            const tools = msg.result.tools
              .filter((t) => typeof t.name === "string" && t.name.length > 0)
              .slice(0, MAX_TOOLS)
              .map((t) => ({
                name: t.name as string,
                description:
                  typeof t.description === "string" ? t.description : undefined,
              }));
            finish({
              serverName,
              transportType: "stdio",
              ok: true,
              tools,
            });
          }
        } catch {
          // Ignore non-JSON or partial frames.
        }
      }
    });

    child.on("error", (err) => {
      finish({
        serverName,
        transportType: "stdio",
        ok: false,
        tools: [],
        error: err.message,
      });
    });

    child.on("exit", (code) => {
      if (!settled) {
        finish({
          serverName,
          transportType: "stdio",
          ok: false,
          tools: [],
          error: `process exited with code ${code ?? "null"} before tools/list`,
        });
      }
    });

    const write = (payload: unknown) => {
      child.stdin?.write(`${JSON.stringify(payload)}\n`);
    };

    // Minimal MCP handshake: initialize → initialized notification → tools/list.
    write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "hyperagent-local", version: "0.1.0" },
      },
    });
    write({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    write({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
  });
}

/**
 * Probe enabled MCP servers for tool catalogs. Non-stdio transports are
 * reported as configured-but-unprobed so the chat prompt still names them.
 */
export async function probeEnabledMcpServers(
  servers: Array<{
    name: string;
    transportType: string;
    configJson: unknown;
  }>,
): Promise<McpServerProbeResult[]> {
  const results: McpServerProbeResult[] = [];
  for (const server of servers.slice(0, 8)) {
    const config =
      server.configJson != null &&
      typeof server.configJson === "object" &&
      !Array.isArray(server.configJson)
        ? (server.configJson as Record<string, unknown>)
        : {};
    if (server.transportType === "stdio") {
      try {
        results.push(await probeStdioMcpServer(server.name, config));
      } catch (err) {
        logger.warn("MCP stdio probe failed", {
          server: server.name,
          error: err instanceof Error ? err.message : String(err),
        });
        results.push({
          serverName: server.name,
          transportType: "stdio",
          ok: false,
          tools: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }
    results.push({
      serverName: server.name,
      transportType: server.transportType,
      ok: false,
      tools: [],
      error: `${server.transportType} tool probing is not implemented in local mode; configure stdio for live tools/list`,
    });
  }
  return results;
}

/**
 * Formats agent-declared tools (toolsJson) for system-prompt injection.
 */
export function formatAgentTools(toolsJson: unknown): string | null {
  if (!Array.isArray(toolsJson) || toolsJson.length === 0) return null;
  const lines: string[] = [];
  for (const raw of toolsJson.slice(0, MAX_TOOLS)) {
    if (raw == null || typeof raw !== "object") continue;
    const tool = raw as Record<string, unknown>;
    const name =
      typeof tool.name === "string"
        ? tool.name
        : typeof tool.function === "object" &&
            tool.function != null &&
            typeof (tool.function as { name?: unknown }).name === "string"
          ? (tool.function as { name: string }).name
          : null;
    if (!name) continue;
    const description =
      typeof tool.description === "string"
        ? tool.description
        : typeof tool.function === "object" &&
            tool.function != null &&
            typeof (tool.function as { description?: unknown }).description ===
              "string"
          ? (tool.function as { description: string }).description
          : undefined;
    lines.push(description ? `- ${name}: ${description}` : `- ${name}`);
  }
  if (lines.length === 0) return null;
  return "## Agent tools\n" + lines.join("\n");
}
