/**
 * MCP HTTP transports for local mode: legacy HTTP+SSE (2024-11-05) and
 * Streamable HTTP (2025-03-26-style POST endpoint). Bounded by timeout;
 * failures return error strings instead of throwing.
 */
import type { McpServerProbeResult, McpToolSummary } from "./mcp-runtime.js";

const PROBE_TIMEOUT_MS = 8_000;
const MAX_TOOLS = 40;
const CLIENT_INFO = { name: "hyperagent-local", version: "0.1.0" };

interface HttpConfig {
  url?: unknown;
  headers?: unknown;
}

export function parseHttpUrl(
  config: Record<string, unknown>,
):
  | { ok: true; url: string; headers: Record<string, string> }
  | { ok: false; error: string } {
  const cfg = config as HttpConfig;
  const url = typeof cfg.url === "string" ? cfg.url.trim() : "";
  if (!url) {
    return {
      ok: false,
      error: "config.url is required for HTTP MCP transport",
    };
  }
  try {
    // Absolute URL only — relative paths cannot resolve without a base.
    new URL(url);
  } catch {
    return { ok: false, error: "config.url must be an absolute URL" };
  }
  const headers: Record<string, string> = {};
  if (
    cfg.headers != null &&
    typeof cfg.headers === "object" &&
    !Array.isArray(cfg.headers)
  ) {
    for (const [key, raw] of Object.entries(
      cfg.headers as Record<string, unknown>,
    )) {
      if (typeof raw === "string") headers[key] = raw;
    }
  }
  return { ok: true, url, headers };
}

function parseTools(raw: unknown): McpToolSummary[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (
        t,
      ): t is { name: string; description?: unknown; inputSchema?: unknown } =>
        t != null &&
        typeof t === "object" &&
        typeof (t as { name?: unknown }).name === "string" &&
        (t as { name: string }).name.length > 0,
    )
    .slice(0, MAX_TOOLS)
    .map((t) => {
      const rawSchema = t.inputSchema;
      const inputSchema =
        rawSchema != null &&
        typeof rawSchema === "object" &&
        !Array.isArray(rawSchema)
          ? (rawSchema as Record<string, unknown>)
          : undefined;
      return {
        name: t.name,
        description:
          typeof t.description === "string" ? t.description : undefined,
        inputSchema,
      };
    });
}

/** Minimal SSE frame parser: accumulates lines until a blank line. */
export function consumeSseFrames(
  buffer: string,
  onEvent: (event: { event: string; data: string }) => void,
): string {
  let rest = buffer;
  let split = rest.indexOf("\n\n");
  while (split !== -1) {
    const frame = rest.slice(0, split);
    rest = rest.slice(split + 2);
    split = rest.indexOf("\n\n");
    let event = "message";
    const dataLines: string[] = [];
    for (const rawLine of frame.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length > 0) {
      onEvent({ event, data: dataLines.join("\n") });
    }
  }
  // Also handle \r\n\r\n if the buffer used CRLF exclusively without \n\n.
  return rest;
}

function resolveEndpointUrl(baseUrl: string, endpoint: string): string {
  try {
    return new URL(endpoint, baseUrl).href;
  } catch {
    return endpoint;
  }
}

type JsonRpcMessage = {
  id?: unknown;
  result?: { tools?: unknown };
  error?: { message?: unknown };
};

function extractJsonRpcFromSseData(data: string): JsonRpcMessage | null {
  try {
    return JSON.parse(data) as JsonRpcMessage;
  } catch {
    return null;
  }
}

async function readJsonOrSseJsonRpc(
  response: Response,
  expectId: number,
  signal: AbortSignal,
): Promise<JsonRpcMessage> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    if (!response.body) {
      throw new Error("SSE response missing body");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let found: JsonRpcMessage | null = null;
    while (!signal.aborted && found == null) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = consumeSseFrames(buffer, ({ event, data }) => {
        if (event !== "message" && event !== "") return;
        const msg = extractJsonRpcFromSseData(data);
        if (msg && msg.id === expectId) found = msg;
      });
    }
    try {
      await reader.cancel();
    } catch {
      // already closed
    }
    if (!found)
      throw new Error(`timed out waiting for JSON-RPC id ${expectId}`);
    return found;
  }

  const body = (await response.json()) as JsonRpcMessage;
  if (body.id !== expectId && body.id != null) {
    // Some servers omit id on errors; still surface the payload.
  }
  return body;
}

/**
 * Legacy HTTP+SSE: GET the SSE URL, learn the POST endpoint, then handshake.
 */
export async function probeSseMcpServer(
  serverName: string,
  config: Record<string, unknown>,
): Promise<McpServerProbeResult> {
  const parsed = parseHttpUrl(config);
  if (!parsed.ok) {
    return {
      serverName,
      transportType: "sse",
      ok: false,
      tools: [],
      error: parsed.error,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const sseResponse = await fetch(parsed.url, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        ...parsed.headers,
      },
      signal: controller.signal,
    });
    if (!sseResponse.ok) {
      return {
        serverName,
        transportType: "sse",
        ok: false,
        tools: [],
        error: `SSE GET failed with HTTP ${sseResponse.status}`,
      };
    }
    if (!sseResponse.body) {
      return {
        serverName,
        transportType: "sse",
        ok: false,
        tools: [],
        error: "SSE response missing body",
      };
    }

    const reader = sseResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let postUrl: string | null = null;
    const pending = new Map<number, (msg: JsonRpcMessage) => void>();

    const waitForId = (id: number): Promise<JsonRpcMessage> =>
      new Promise((resolve, reject) => {
        if (controller.signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        pending.set(id, resolve);
        const onAbort = () => {
          pending.delete(id);
          reject(new Error(`timed out waiting for JSON-RPC id ${id}`));
        };
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });

    void (async () => {
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = consumeSseFrames(buffer, ({ event, data }) => {
          if (event === "endpoint") {
            postUrl = resolveEndpointUrl(parsed.url, data.trim());
            return;
          }
          if (event === "message" || event === "") {
            const msg = extractJsonRpcFromSseData(data);
            if (msg && typeof msg.id === "number") {
              const waiter = pending.get(msg.id);
              if (waiter) {
                pending.delete(msg.id);
                waiter(msg);
              }
            }
          }
        });
      }
    })().catch(() => {
      // stream closed
    });

    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    while (
      postUrl == null &&
      Date.now() < deadline &&
      !controller.signal.aborted
    ) {
      await new Promise((r) => setTimeout(r, 25));
    }
    if (!postUrl) {
      controller.abort();
      return {
        serverName,
        transportType: "sse",
        ok: false,
        tools: [],
        error: "SSE endpoint event not received before timeout",
      };
    }

    const post = async (payload: unknown) => {
      const res = await fetch(postUrl!, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...parsed.headers,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok && res.status !== 202) {
        throw new Error(`SSE POST failed with HTTP ${res.status}`);
      }
    };

    const initWait = waitForId(1);
    await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
    });
    const initMsg = await initWait;
    if (initMsg.error) {
      return {
        serverName,
        transportType: "sse",
        ok: false,
        tools: [],
        error:
          typeof initMsg.error.message === "string"
            ? initMsg.error.message
            : "initialize failed",
      };
    }

    await post({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    const listWait = waitForId(2);
    await post({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const listMsg = await listWait;
    if (listMsg.error) {
      return {
        serverName,
        transportType: "sse",
        ok: false,
        tools: [],
        error:
          typeof listMsg.error.message === "string"
            ? listMsg.error.message
            : "tools/list failed",
      };
    }

    return {
      serverName,
      transportType: "sse",
      ok: true,
      tools: parseTools(listMsg.result?.tools),
    };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === "AbortError"
          ? `probe timed out after ${PROBE_TIMEOUT_MS}ms`
          : err.message
        : String(err);
    return {
      serverName,
      transportType: "sse",
      ok: false,
      tools: [],
      error: message,
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/**
 * Streamable HTTP: POST JSON-RPC to a single MCP endpoint; accept JSON or SSE.
 */
export async function probeStreamableHttpMcpServer(
  serverName: string,
  config: Record<string, unknown>,
): Promise<McpServerProbeResult> {
  const parsed = parseHttpUrl(config);
  if (!parsed.ok) {
    return {
      serverName,
      transportType: "streamable-http",
      ok: false,
      tools: [],
      error: parsed.error,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const baseHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26",
      ...parsed.headers,
    };

    const initRes = await fetch(parsed.url, {
      method: "POST",
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: CLIENT_INFO,
        },
      }),
      signal: controller.signal,
    });
    if (!initRes.ok) {
      return {
        serverName,
        transportType: "streamable-http",
        ok: false,
        tools: [],
        error: `initialize failed with HTTP ${initRes.status}`,
      };
    }
    const sessionId = initRes.headers.get("mcp-session-id");
    const initMsg = await readJsonOrSseJsonRpc(initRes, 1, controller.signal);
    if (initMsg.error) {
      return {
        serverName,
        transportType: "streamable-http",
        ok: false,
        tools: [],
        error:
          typeof initMsg.error.message === "string"
            ? initMsg.error.message
            : "initialize failed",
      };
    }

    const sessionHeaders: Record<string, string> = { ...baseHeaders };
    if (sessionId) sessionHeaders["Mcp-Session-Id"] = sessionId;

    const initializedRes = await fetch(parsed.url, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
      signal: controller.signal,
    });
    if (!initializedRes.ok && initializedRes.status !== 202) {
      return {
        serverName,
        transportType: "streamable-http",
        ok: false,
        tools: [],
        error: `initialized notification failed with HTTP ${initializedRes.status}`,
      };
    }

    const listRes = await fetch(parsed.url, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
      signal: controller.signal,
    });
    if (!listRes.ok) {
      return {
        serverName,
        transportType: "streamable-http",
        ok: false,
        tools: [],
        error: `tools/list failed with HTTP ${listRes.status}`,
      };
    }
    const listMsg = await readJsonOrSseJsonRpc(listRes, 2, controller.signal);
    if (listMsg.error) {
      return {
        serverName,
        transportType: "streamable-http",
        ok: false,
        tools: [],
        error:
          typeof listMsg.error.message === "string"
            ? listMsg.error.message
            : "tools/list failed",
      };
    }

    return {
      serverName,
      transportType: "streamable-http",
      ok: true,
      tools: parseTools(listMsg.result?.tools),
    };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === "AbortError"
          ? `probe timed out after ${PROBE_TIMEOUT_MS}ms`
          : err.message
        : String(err);
    return {
      serverName,
      transportType: "streamable-http",
      ok: false,
      tools: [],
      error: message,
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
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

export async function callSseMcpTool(
  config: Record<string, unknown>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const parsed = parseHttpUrl(config);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const sseResponse = await fetch(parsed.url, {
      method: "GET",
      headers: { Accept: "text/event-stream", ...parsed.headers },
      signal: controller.signal,
    });
    if (!sseResponse.ok || !sseResponse.body) {
      return {
        ok: false,
        error: `SSE GET failed with HTTP ${sseResponse.status}`,
      };
    }
    const reader = sseResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let postUrl: string | null = null;
    const pending = new Map<number, (msg: JsonRpcMessage) => void>();
    const waitForId = (id: number) =>
      new Promise<JsonRpcMessage>((resolve, reject) => {
        pending.set(id, resolve);
        controller.signal.addEventListener(
          "abort",
          () => {
            pending.delete(id);
            reject(new Error(`timed out waiting for JSON-RPC id ${id}`));
          },
          { once: true },
        );
      });

    void (async () => {
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = consumeSseFrames(buffer, ({ event, data }) => {
          if (event === "endpoint") {
            postUrl = resolveEndpointUrl(parsed.url, data.trim());
            return;
          }
          if (event === "message" || event === "") {
            const msg = extractJsonRpcFromSseData(data);
            if (msg && typeof msg.id === "number") {
              const waiter = pending.get(msg.id);
              if (waiter) {
                pending.delete(msg.id);
                waiter(msg);
              }
            }
          }
        });
      }
    })().catch(() => undefined);

    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    while (
      postUrl == null &&
      Date.now() < deadline &&
      !controller.signal.aborted
    ) {
      await new Promise((r) => setTimeout(r, 25));
    }
    if (!postUrl) {
      return {
        ok: false,
        error: "SSE endpoint event not received before timeout",
      };
    }

    const post = async (payload: unknown) => {
      const res = await fetch(postUrl!, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...parsed.headers },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok && res.status !== 202) {
        throw new Error(`SSE POST failed with HTTP ${res.status}`);
      }
    };

    const initWait = waitForId(1);
    await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
    });
    await initWait;
    await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    const callWait = waitForId(2);
    await post({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    });
    const callMsg = await callWait;
    if (callMsg.error) {
      return {
        ok: false,
        error:
          typeof callMsg.error.message === "string"
            ? callMsg.error.message
            : "tools/call failed",
      };
    }
    return { ok: true, text: formatToolCallResult(callMsg.result) };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.name === "AbortError"
            ? `tools/call timed out after ${PROBE_TIMEOUT_MS}ms`
            : err.message
          : String(err),
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function callStreamableHttpMcpTool(
  config: Record<string, unknown>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const parsed = parseHttpUrl(config);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const baseHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26",
      ...parsed.headers,
    };

    const initRes = await fetch(parsed.url, {
      method: "POST",
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: CLIENT_INFO,
        },
      }),
      signal: controller.signal,
    });
    if (!initRes.ok) {
      return {
        ok: false,
        error: `initialize failed with HTTP ${initRes.status}`,
      };
    }
    const sessionId = initRes.headers.get("mcp-session-id");
    await readJsonOrSseJsonRpc(initRes, 1, controller.signal);

    const sessionHeaders: Record<string, string> = { ...baseHeaders };
    if (sessionId) sessionHeaders["Mcp-Session-Id"] = sessionId;

    await fetch(parsed.url, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
      signal: controller.signal,
    });

    const callRes = await fetch(parsed.url, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
      signal: controller.signal,
    });
    if (!callRes.ok) {
      return {
        ok: false,
        error: `tools/call failed with HTTP ${callRes.status}`,
      };
    }
    const callMsg = await readJsonOrSseJsonRpc(callRes, 2, controller.signal);
    if (callMsg.error) {
      return {
        ok: false,
        error:
          typeof callMsg.error.message === "string"
            ? callMsg.error.message
            : "tools/call failed",
      };
    }
    return { ok: true, text: formatToolCallResult(callMsg.result) };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.name === "AbortError"
            ? `tools/call timed out after ${PROBE_TIMEOUT_MS}ms`
            : err.message
          : String(err),
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
