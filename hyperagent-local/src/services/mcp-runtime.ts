import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { logger } from "../lib/logger.js";

export interface McpToolSummary {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolBinding {
  /** OpenAI function name: mcp__<server>__<tool> */
  openaiName: string;
  serverName: string;
  toolName: string;
  config: Record<string, unknown>;
  description?: string;
  inputSchema?: Record<string, unknown>;
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
              .map((t) => {
                const rawSchema = (t as { inputSchema?: unknown }).inputSchema;
                const inputSchema =
                  rawSchema != null &&
                  typeof rawSchema === "object" &&
                  !Array.isArray(rawSchema)
                    ? (rawSchema as Record<string, unknown>)
                    : undefined;
                return {
                  name: t.name as string,
                  description:
                    typeof t.description === "string"
                      ? t.description
                      : undefined,
                  inputSchema,
                };
              });
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

function sanitizeToolSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
}

export function mcpOpenAiToolName(
  serverName: string,
  toolName: string,
): string {
  return `mcp__${sanitizeToolSegment(serverName)}__${sanitizeToolSegment(toolName)}`;
}

/**
 * Build OpenAI tool bindings from successful stdio probes.
 */
export function buildMcpToolBindings(
  probes: McpServerProbeResult[],
  servers: Array<{
    name: string;
    transportType: string;
    configJson: unknown;
  }>,
): McpToolBinding[] {
  const byName = new Map(
    servers.map((s) => [
      s.name,
      s.configJson != null &&
      typeof s.configJson === "object" &&
      !Array.isArray(s.configJson)
        ? (s.configJson as Record<string, unknown>)
        : {},
    ]),
  );
  const bindings: McpToolBinding[] = [];
  for (const probe of probes) {
    if (!probe.ok || probe.transportType !== "stdio") continue;
    const config = byName.get(probe.serverName) ?? {};
    for (const tool of probe.tools) {
      bindings.push({
        openaiName: mcpOpenAiToolName(probe.serverName, tool.name),
        serverName: probe.serverName,
        toolName: tool.name,
        config,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }
  }
  return bindings.slice(0, MAX_TOOLS);
}

export function bindingsToOpenAiTools(bindings: McpToolBinding[]): Array<{
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}> {
  return bindings.map((b) => ({
    type: "function" as const,
    function: {
      name: b.openaiName,
      description:
        b.description ?? `MCP tool ${b.toolName} from server ${b.serverName}`,
      parameters: b.inputSchema ?? {
        type: "object",
        properties: {},
      },
    },
  }));
}

/**
 * Invoke tools/call on a stdio MCP server. Bounded by timeout.
 */
export async function callStdioMcpTool(
  config: Record<string, unknown>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const cfg = config as StdioConfig;
  const command = typeof cfg.command === "string" ? cfg.command.trim() : "";
  if (!command) {
    return {
      ok: false,
      error: "config.command is required for stdio transport",
    };
  }
  const spawnArgs = asStringArray(cfg.args);
  const cwd = typeof cfg.cwd === "string" ? cfg.cwd : undefined;
  const env = asEnv(cfg.env);

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (
      result: { ok: true; text: string } | { ok: false; error: string },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGTERM");
      } catch {
        // already exited
      }
      resolve(result);
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, spawnArgs, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: `tools/call timed out after ${PROBE_TIMEOUT_MS}ms`,
      });
    }, PROBE_TIMEOUT_MS);

    let stdout = "";
    let initialized = false;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      let newline = stdout.indexOf("\n");
      while (newline !== -1) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        newline = stdout.indexOf("\n");
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as {
            id?: unknown;
            result?: unknown;
            error?: { message?: unknown };
          };
          if (msg.id === 1 && !initialized) {
            initialized = true;
            child.stdin?.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                method: "notifications/initialized",
              })}\n`,
            );
            child.stdin?.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: { name: toolName, arguments: args },
              })}\n`,
            );
            continue;
          }
          if (msg.id === 2) {
            if (msg.error) {
              finish({
                ok: false,
                error:
                  typeof msg.error.message === "string"
                    ? msg.error.message
                    : "tools/call failed",
              });
              return;
            }
            const text = formatToolCallResult(msg.result);
            finish({ ok: true, text });
          }
        } catch {
          // ignore partial frames
        }
      }
    });

    child.on("error", (err) => {
      finish({ ok: false, error: err.message });
    });
    child.on("exit", (code) => {
      if (!settled) {
        finish({
          ok: false,
          error: `process exited with code ${code ?? "null"} before tools/call`,
        });
      }
    });

    child.stdin?.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "hyperagent-local", version: "0.1.0" },
        },
      })}\n`,
    );
  });
}

function formatToolCallResult(result: unknown): string {
  if (result == null) return "(empty tool result)";
  if (typeof result === "string") return result.slice(0, 32_000);
  if (typeof result === "object" && result !== null && "content" in result) {
    const content = (result as { content: unknown }).content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (part != null && typeof part === "object" && "text" in part) {
            return String((part as { text: unknown }).text);
          }
          return JSON.stringify(part);
        })
        .join("\n")
        .slice(0, 32_000);
    }
  }
  try {
    return JSON.stringify(result).slice(0, 32_000);
  } catch {
    return String(result).slice(0, 32_000);
  }
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
