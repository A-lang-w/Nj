import {
  hostHeaderValidationResponse,
  isInitializeRequest,
  localhostAllowedHostnames,
  originValidationResponse,
  readRequestBody,
  WebStandardStreamableHTTPServerTransport,
  type McpServer,
  type McpServerFactory,
  type Server,
} from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { isIPv4, isIPv6 } from "node:net";
import type { Logger } from "pino";

import { toWebRequest, writeWebResponse } from "./nodeHttpBridge.js";
import { StreamableHttpListenError } from "./streamableHttpListenError.js";

/** MCP endpoint path shared by `rea mcp --http` and agent environment servers. */
export const MCP_HTTP_PATH = "/mcp";

/** One plain HTTP route served beside the MCP endpoint as web Request to Response. */
export interface StreamableHttpRoute {
  readonly method: string;
  readonly path: string;
  readonly handle: (request: Request) => Response | Promise<Response>;
}

export interface ServeStreamableHttpOptions {
  readonly host: string;
  readonly port: number;
  /** Called once; the instance serves every session in turn on a fresh transport. */
  readonly createMcpServer: McpServerFactory;
  readonly routes?: readonly StreamableHttpRoute[];
  readonly logger?: Logger;
  /** Reports listener failures after binding; request failures are logged instead. */
  readonly onerror?: (error: Error) => void;
}

export interface StreamableHttpServer {
  /** The bound MCP endpoint URL. */
  readonly url: string;
  readonly close: () => Promise<void>;
}

/** The bind host as the SDK compares Host headers: lowercase, IPv6 bracketed and canonical. */
const normalizedHostname = (host: string): string | undefined => {
  try {
    return new URL(`http://${isIPv6(host) ? `[${host}]` : host}`).hostname;
  } catch {
    return undefined;
  }
};
const isLoopbackIpv4 = (address: string): boolean =>
  isIPv4(address) && address.startsWith("127.");
/** Loopback by address class and localhost names, so no spelling of a local bind skips validation. */
const isLoopbackHostname = (hostname: string): boolean => {
  if (
    hostname === "localhost" ||
    hostname === "localhost." ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".localhost.")
  )
    return true;
  if (isLoopbackIpv4(hostname)) return true;
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return false;
  const inner = hostname.slice(1, -1);
  if (inner === "::1") return true;
  if (!inner.startsWith("::ffff:")) return false;
  const mapped = inner.slice("::ffff:".length);
  if (isLoopbackIpv4(mapped)) return true;
  const hex = /^([0-9a-f]{1,4}):[0-9a-f]{1,4}$/u.exec(mapped);
  return hex !== null && Number.parseInt(hex[1] ?? "0", 16) >> 8 === 0x7f;
};
/** Host and Origin allowlist for a loopback bind, including the bind's own hostname; undefined relaxes validation. */
export const hostHeaderAllowlist = (host: string): string[] | undefined => {
  const hostname = normalizedHostname(host);
  if (hostname === undefined || !isLoopbackHostname(hostname)) return undefined;
  return [...new Set([...localhostAllowedHostnames(), hostname])];
};

const jsonError = (status: number, code: number, message: string): Response =>
  Response.json(
    { jsonrpc: "2.0", error: { code, message }, id: null },
    { status },
  );

const protocolOf = (instance: McpServer | Server): Server =>
  "server" in instance ? instance.server : instance;

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const NO_SHUTDOWN_HOOK = (): void => undefined;
const SHUTTING_DOWN = (): Response =>
  jsonError(503, -32000, "Server shutting down");

/** The headers the SDK requires of a streamable POST; a request without them is left to the transport's refusal. */
const hasStreamablePostHeaders = (request: Request): boolean => {
  const accept = request.headers.get("accept") ?? "";
  const contentType = request.headers.get("content-type") ?? "";
  // The media type proper, without parameters: `application/json-patch+json` is not JSON here.
  const essence = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  return (
    accept.includes("application/json") &&
    accept.includes("text/event-stream") &&
    essence === "application/json"
  );
};

/** Only a new client's initialize travels without a session id; peek within the SDK body bound. */
const isInitializePost = async (request: Request): Promise<boolean> => {
  if (
    request.method !== "POST" ||
    request.headers.has("mcp-session-id") ||
    !hasStreamablePostHeaders(request)
  )
    return false;
  const probe = request.clone();
  try {
    const read = await readRequestBody(probe);
    if (read.tooLarge) return false;
    const body: unknown = JSON.parse(read.text);
    return Array.isArray(body)
      ? body.some((message) => isInitializeRequest(message))
      : isInitializeRequest(body);
  } catch {
    return false;
  } finally {
    await probe.body?.cancel().catch(() => undefined);
  }
};

/** The connected transport of one session and the SDK close that ends it as a server shutdown. */
interface LiveSession {
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly shutdown: () => Promise<void>;
}

/** Owns the single connected server and the transport of its current session. */
export class McpSessionSlot {
  #live: LiveSession | undefined;
  #arming: Promise<WebStandardStreamableHTTPServerTransport> | undefined;
  #closed = false;
  /** The instance's own close hook, captured once so every session end restores exactly it. */
  readonly #shutdownHook: () => void;

  constructor(
    private readonly instance: McpServer | Server,
    private readonly logger: Logger | undefined,
  ) {
    this.#shutdownHook = protocolOf(instance).onclose ?? NO_SHUTDOWN_HOOK;
  }

  /** Route one MCP request; a new client's initialize replaces a session its predecessor left open. */
  async handle(request: Request): Promise<Response> {
    if (this.#closed) return SHUTTING_DOWN();
    const open = this.#live;
    if (
      open?.transport.sessionId !== undefined &&
      (await isInitializePost(request))
    ) {
      if (this.#closed) return SHUTTING_DOWN();
      this.logger?.info("MCP HTTP session replaced by a new client");
      await open.transport.close();
    }
    const transport = await this.#current();
    // Shutdown may have closed the slot while this request was arming it.
    if (this.#closed) return SHUTTING_DOWN();
    return transport.handleRequest(request);
  }

  /** End the live session as part of server shutdown, so the instance's onclose runs; later requests are refused. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#arming?.catch(() => undefined);
    const open = this.#live;
    this.#live = undefined;
    await open?.shutdown();
  }

  #current(): Promise<WebStandardStreamableHTTPServerTransport> {
    if (this.#closed)
      return Promise.reject(new Error("MCP HTTP session slot is closed"));
    if (this.#live !== undefined) return Promise.resolve(this.#live.transport);
    this.#arming ??= this.#arm().finally(() => {
      this.#arming = undefined;
    });
    return this.#arming;
  }

  async #arm(): Promise<WebStandardStreamableHTTPServerTransport> {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: () => this.logger?.info("MCP HTTP session opened"),
      onsessionclosed: () =>
        this.logger?.info("MCP HTTP session closed by the client"),
    });
    const shutdown = transport.close.bind(transport);
    // The SDK closes the transport on DELETE; that ends the session, not the server.
    transport.close = () => this.#endSession(transport, shutdown);
    await this.instance.connect(transport);
    this.#live = { transport, shutdown };
    return transport;
  }

  /** Close one session's transport while the instance's onclose hooks wait for close(). */
  async #endSession(
    transport: WebStandardStreamableHTTPServerTransport,
    shutdown: () => Promise<void>,
  ): Promise<void> {
    const protocol = protocolOf(this.instance);
    protocol.onclose = NO_SHUTDOWN_HOOK;
    try {
      await shutdown();
    } finally {
      protocol.onclose = this.#shutdownHook;
      if (this.#live?.transport === transport) this.#live = undefined;
    }
  }
}

const endpointUrl = (
  address: ReturnType<ReturnType<typeof createHttpServer>["address"]>,
): string => {
  if (address === null || typeof address === "string")
    throw new TypeError("MCP HTTP listener has no TCP address");
  const host =
    address.family === "IPv6" ? `[${address.address}]` : address.address;
  return `http://${host}:${String(address.port)}${MCP_HTTP_PATH}`;
};

/** Serve one MCP server, plus plain routes, over streamable HTTP until closed. */
export const serveStreamableHttp = async (
  options: ServeStreamableHttpOptions,
): Promise<StreamableHttpServer> => {
  const { host, port, logger, routes = [] } = options;
  const allowedHosts = hostHeaderAllowlist(host);
  // The instance is created after the listener binds, so a bind failure leaves nothing to clean up.
  let slot: McpSessionSlot | undefined;
  let origin = "";
  let stopped = false;
  const route = async (request: Request): Promise<Response> => {
    if (stopped) return jsonError(503, -32000, "Server shutting down");
    // One loopback allowlist gates Host (DNS rebinding) and Origin (browser pages); a missing Origin passes.
    const refused =
      allowedHosts === undefined
        ? undefined
        : (hostHeaderValidationResponse(request, allowedHosts) ??
          originValidationResponse(request, allowedHosts));
    if (refused !== undefined) return refused;
    const { pathname } = new URL(request.url);
    if (pathname === MCP_HTTP_PATH)
      return slot === undefined
        ? jsonError(503, -32000, "Server starting")
        : slot.handle(request);
    const match = routes.find(
      (candidate) =>
        candidate.path === pathname && candidate.method === request.method,
    );
    return match === undefined
      ? jsonError(404, -32601, `No route for ${request.method} ${pathname}`)
      : match.handle(request);
  };
  const httpServer = createHttpServer();
  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      const webResponse = await route(toWebRequest(request, response, origin));
      await writeWebResponse(webResponse, response);
    } catch (cause: unknown) {
      // A client that left mid-stream is routine; a failure before headers is not.
      logger?.[response.headersSent ? "debug" : "warn"](
        { error: describe(cause) },
        "MCP HTTP request did not complete",
      );
      if (response.headersSent) response.destroy();
      else
        await writeWebResponse(
          jsonError(500, -32603, "Internal server error"),
          response,
        ).catch(() => undefined);
    }
  };
  httpServer.on("request", (request, response) => {
    void handleRequest(request, response);
  });
  httpServer.on("error", (error) => options.onerror?.(error));
  const closeListener = async (): Promise<void> => {
    stopped = true;
    httpServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) =>
        error === undefined ? resolve() : reject(error),
      );
    });
  };
  try {
    httpServer.listen(port, host);
    await once(httpServer, "listening");
  } catch (cause: unknown) {
    throw new StreamableHttpListenError(cause);
  }
  const url = endpointUrl(httpServer.address());
  origin = new URL(url).origin;
  let instance: McpServer | Server;
  try {
    instance = await options.createMcpServer({ era: "legacy" });
  } catch (cause: unknown) {
    // No instance exists yet, so the listener is the only resource to release.
    await closeListener().catch(() => undefined);
    throw cause;
  }
  protocolOf(instance).onerror = (error) =>
    logger?.warn({ error: error.message }, "MCP HTTP request rejected");
  const live = new McpSessionSlot(instance, logger);
  slot = live;
  if (allowedHosts === undefined)
    logger?.warn(
      { host },
      "MCP HTTP Host header validation relaxed for a non-loopback bind",
    );
  // The URL is the only way to reach an ephemeral port, so the announcement ignores the log threshold.
  logger
    ?.child({}, { level: "info" })
    .info({ transport: "streamable-http", url }, "MCP transport listening");
  const close = stagedClose([
    closeListener,
    () => live.close(),
    () => instance.close(),
  ]);
  return { url, close };
};

/** Run close stages in order once each; a failed stage is retried by the next call instead of replaying its rejection. */
const stagedClose = (
  stages: readonly (() => Promise<void>)[],
): (() => Promise<void>) => {
  const done = stages.map(() => false);
  let closing: Promise<void> | undefined;
  return () => {
    if (closing !== undefined) return closing;
    const attempt = (async () => {
      for (const [index, stage] of stages.entries()) {
        if (done[index]) continue;
        await stage();
        done[index] = true;
      }
    })();
    closing = attempt;
    void attempt.catch(() => {
      if (closing === attempt) closing = undefined;
    });
    return attempt;
  };
};
