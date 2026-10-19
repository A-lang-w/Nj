import {
  hostHeaderValidationResponse,
  isInitializeRequest,
  isJsonContentType,
  localhostAllowedHostnames,
  originValidationResponse,
  readRequestBody,
  WebStandardStreamableHTTPServerTransport,
  type McpServer,
  type McpRequestContext,
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

import {
  toWebRequest,
  UnsupportedRequestTargetError,
  writeWebResponse,
} from "./nodeHttpBridge.js";
import { StreamableHttpListenError } from "./streamableHttpListenError.js";
import { RequestTrackingMcpServer } from "../RequestTrackingMcpServer.js";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";

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
  readonly createMcpServer: (
    context: McpRequestContext,
  ) => RequestTrackingMcpServer | Promise<RequestTrackingMcpServer>;
  /** Maximum time a client session handover waits for cancelled tool/completion handlers. */
  readonly sessionDrainTimeoutMs?: number;
  /** Concurrent HTTP input/route work (default 8); unread uploads retain their permit. */
  readonly maxConcurrentDispatches?: number;
  readonly routes?: readonly StreamableHttpRoute[];
  readonly logger?: Logger;
  /** Reports listener failures after binding; request failures are logged instead. */
  readonly onerror?: (error: Error) => void;
  /** Close the server instance as the last stage of `close`; false when the factory's owner closes it. */
  readonly closeInstance?: boolean;
}

export interface StreamableHttpServer {
  /** The bound MCP endpoint URL. */
  readonly url: string;
  /** Stop incoming dispatch and drain handlers before shared provider owners close. */
  readonly prepareShutdown: () => Promise<void>;
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
/** Host and Origin allowlist when the configured host or the address it bound is loopback, including both names; undefined relaxes validation. */
export const hostHeaderAllowlist = (
  host: string,
  boundAddress = host,
): string[] | undefined => {
  const names = [normalizedHostname(host), normalizedHostname(boundAddress)];
  const known = names.filter((name): name is string => name !== undefined);
  if (!known.some((name) => isLoopbackHostname(name))) return undefined;
  return [...new Set([...localhostAllowedHostnames(), ...known])];
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
const SESSION_NOT_FOUND = (): Response =>
  jsonError(404, -32001, "Session not found");
const DEFAULT_SESSION_DRAIN_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONCURRENT_DISPATCHES = 8;

class SessionDrainTimeoutError extends AnalysisResourceConstraintError {
  constructor(timeoutMs: number) {
    super(
      "mcp_http_session",
      "transport",
      "Previous MCP session still has running requests; retry after they finish",
      { drain_timeout_ms: timeoutMs },
    );
  }
}

/** Split a header field on `separator` outside quoted strings, honouring backslash escapes (RFC 9110). */
const splitUnquoted = (value: string, separator: string): string[] => {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  for (const char of value) {
    if (escaped) escaped = false;
    else if (quoted && char === "\\") escaped = true;
    else if (char === '"') quoted = !quoted;
    else if (char === separator && !quoted) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
};
/** The media type proper of one header value or Accept range: no parameters, lowercase. */
const mediaType = (value: string): string =>
  (splitUnquoted(value, ";")[0] ?? "").trim().toLowerCase();
/** An Accept range's quality weight; a missing or unreadable `q` counts as 1, as in RFC 9110. */
const quality = (range: string): number => {
  const q = splitUnquoted(range, ";")
    .slice(1)
    .map((parameter) => parameter.split("="))
    .find(([name]) => name?.trim().toLowerCase() === "q")?.[1];
  const value = q === undefined ? 1 : Number(q.trim());
  return Number.isFinite(value) ? value : 1;
};
/** The headers the SDK requires of a streamable POST; a request without them is left to the transport's refusal. */
const hasStreamablePostHeaders = (request: Request): boolean => {
  const accept = request.headers.get("accept") ?? "";
  // Exact media ranges with a positive weight: `application/json-patch+json`, `text/event-streaming`
  // and `application/json;q=0` do not count.
  const accepted = new Set(
    splitUnquoted(accept, ",")
      .filter((range) => quality(range) > 0)
      .map(mediaType),
  );
  // The SDK's own checks too: its Accept test is a case-sensitive substring match, so a header it
  // would refuse with 406 (such as `Application/JSON`) must not close the live session first.
  return (
    accepted.has("application/json") &&
    accepted.has("text/event-stream") &&
    accept.includes("application/json") &&
    accept.includes("text/event-stream") &&
    isJsonContentType(request.headers.get("content-type"))
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
    // The transport accepts only a lone initialize, so only that may evict a session.
    return Array.isArray(body)
      ? body.length === 1 && isInitializeRequest(body[0])
      : isInitializeRequest(body);
  } catch {
    return false;
  } finally {
    // The clone is one branch of a tee; awaiting its cancel would wait for the original to drain.
    void probe.body?.cancel().catch(() => undefined);
  }
};

/** Owns parsing and dispatch as well as the connected transport of one session. */
class LiveSession {
  #closed = false;
  readonly #bodyAbort = new AbortController();
  readonly #shutdown: () => Promise<void>;

  constructor(
    readonly transport: WebStandardStreamableHTTPServerTransport,
    private readonly instance: RequestTrackingMcpServer,
  ) {
    this.#shutdown = transport.close.bind(transport);
  }

  /** Install after connect, so the SDK and Evidence adapter have bound their callbacks. */
  fenceDispatch(): void {
    const dispatch = this.transport.onmessage;
    this.transport.onmessage = (...args) => {
      if (!this.#closed) dispatch?.(...args);
    };
  }

  handle(request: Request): Promise<Response> {
    if (this.#closed) return Promise.resolve(SESSION_NOT_FOUND());
    // DELETE awaits this session's close; including it in its own drain would deadlock.
    if (request.method === "DELETE")
      return this.transport.handleRequest(request);
    return Promise.resolve(
      this.instance.runRequest(undefined, async () => {
        if (this.#closed) return SESSION_NOT_FOUND();
        const bodyAbort = new AbortController();
        try {
          const guarded =
            request.body === null
              ? request
              : new Request(request, {
                  body: request.body.pipeThrough(
                    new TransformStream<Uint8Array, Uint8Array>(),
                    {
                      signal: AbortSignal.any([
                        this.#bodyAbort.signal,
                        bodyAbort.signal,
                      ]),
                    },
                  ),
                  duplex: "half",
                } as RequestInit);
          const response = await this.transport.handleRequest(guarded);
          if (!this.#closed) return response;
          // The SDK may have crossed an await before close and created its SSE
          // response afterwards. Cancel that stream before releasing its owner.
          await response.body?.cancel();
          return SESSION_NOT_FOUND();
        } finally {
          // Header/size refusals can leave the SDK body unread. Its forwarding
          // stream belongs to this dispatch, not the remaining session lifetime.
          bodyAbort.abort();
        }
      }),
    );
  }

  shutdown(): Promise<void> {
    this.#closed = true;
    this.#bodyAbort.abort();
    return this.#shutdown();
  }
}

/** Owns the single connected server and the transport of its current session. */
export class McpSessionSlot {
  #live: LiveSession | undefined;
  #arming: Promise<LiveSession> | undefined;
  #closed = false;
  #hookRan = false;
  #draining = false;
  #ending: Promise<void> | undefined;
  /** The instance's own close hook, captured once; it runs exactly once, when the listener closes. */
  readonly #shutdownHook: () => void;

  constructor(
    private readonly instance: RequestTrackingMcpServer,
    private readonly logger: Logger | undefined,
    private readonly drainTimeoutMs = DEFAULT_SESSION_DRAIN_TIMEOUT_MS,
  ) {
    instance.enableRequestTracking();
    const protocol = protocolOf(instance);
    const captured = protocol.onclose ?? NO_SHUTDOWN_HOOK;
    let running = false;
    // Completion is recorded only after the hook returns, so a hook that threw stays eligible for a retry.
    this.#shutdownHook = () => {
      if (this.#hookRan || running) return;
      running = true;
      try {
        captured();
        this.#hookRan = true;
      } finally {
        running = false;
      }
    };
    protocol.onclose = this.#shutdownHook;
  }

  /** Route one MCP request; a new client's initialize replaces a session its predecessor left open. */
  async handle(request: Request): Promise<Response> {
    try {
      return await this.#handle(request);
    } catch (cause: unknown) {
      if (!(cause instanceof SessionDrainTimeoutError)) throw cause;
      return jsonError(503, -32000, cause.message);
    }
  }

  async #handle(request: Request): Promise<Response> {
    if (this.#closed) return SHUTTING_DOWN();
    if (this.#draining) await this.#live?.transport.close();
    if (this.#closed) return SHUTTING_DOWN();
    const open = this.#live;
    if (
      open?.transport.sessionId !== undefined &&
      (await isInitializePost(request)) &&
      // A client that left while its initialize was probed would evict the session for nobody.
      !request.signal.aborted
    ) {
      if (this.#closed) return SHUTTING_DOWN();
      this.logger?.info("MCP HTTP session replaced by a new client");
      await open.transport.close();
    }
    if (this.#closed) return SHUTTING_DOWN();
    const session = await this.#current();
    // Shutdown may have closed the slot while this request was arming it.
    if (this.#closed) return SHUTTING_DOWN();
    return session.handle(request);
  }

  /** Cancel and drain MCP work before any shared provider shutdown hook can run. */
  async prepareShutdown(): Promise<void> {
    this.#closed = true;
    await this.#arming?.catch(() => undefined);
    const open = this.#live;
    // The session stays owned until its shutdown succeeds, so a retry can finish it.
    try {
      await open?.transport.close();
    } catch (cause: unknown) {
      // Shutdown may have joined a handover that already started its bounded
      // drain. Retry that timeout with shutdown's completion-based wait.
      if (!(cause instanceof SessionDrainTimeoutError)) throw cause;
      await open?.transport.close();
    }
    if (this.#live === open) this.#live = undefined;
  }

  /** Finish shutdown once every consumer of the shared providers has settled. */
  async close(): Promise<void> {
    await this.prepareShutdown();
    // Without a live transport nothing fires the instance's hook; run it here, once.
    this.#shutdownHook();
  }

  #current(): Promise<LiveSession> {
    if (this.#closed)
      return Promise.reject(new Error("MCP HTTP session slot is closed"));
    if (this.#live !== undefined) return Promise.resolve(this.#live);
    this.#arming ??= this.#arm().finally(() => {
      this.#arming = undefined;
    });
    return this.#arming;
  }

  async #arm(): Promise<LiveSession> {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: () => this.logger?.info("MCP HTTP session opened"),
      onsessionclosed: () =>
        this.logger?.info("MCP HTTP session closed by the client"),
    });
    const session = new LiveSession(transport, this.instance);
    // The SDK closes the transport on DELETE; that ends the session, not the server.
    transport.close = () => this.#endSession(session);
    await this.instance.connect(transport);
    session.fenceDispatch();
    this.#live = session;
    return session;
  }

  /** Close one session's transport while the instance's onclose hooks wait for close(). */
  async #endSession(session: LiveSession): Promise<void> {
    if (this.#live !== session) return;
    if (this.#ending !== undefined) return this.#ending;
    this.#draining = true;
    const ending = this.#finishSession(session).finally(() => {
      if (this.#ending === ending) this.#ending = undefined;
    });
    this.#ending = ending;
    return ending;
  }

  async #finishSession(session: LiveSession): Promise<void> {
    const protocol = protocolOf(this.instance);
    protocol.onclose = NO_SHUTDOWN_HOOK;
    try {
      await session.shutdown();
      if (
        !(await this.instance.drainRequests(
          this.#closed ? undefined : this.drainTimeoutMs,
        ))
      )
        throw new SessionDrainTimeoutError(this.drainTimeoutMs);
      // A timed-out handler remains owned and blocks reuse until a later drain succeeds.
      if (this.#live === session) this.#live = undefined;
      this.#draining = false;
    } finally {
      protocol.onclose = this.#shutdownHook;
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

interface NodeRequestTarget {
  readonly route: (request: Request) => Promise<Response>;
  readonly origin: () => string;
  readonly logger: Logger | undefined;
}

/** Own admission and route completion before a Web Request, body reader or initialize tee exists. */
const createNodeRequestOwner = (
  target: NodeRequestTarget,
  capacity: number,
) => {
  if (!Number.isSafeInteger(capacity) || capacity < 1)
    throw new RangeError(
      "maxConcurrentDispatches must be a positive safe integer",
    );
  let active = 0;
  const dispatches = new Set<Promise<Response>>();
  const ownedTarget: NodeRequestTarget = {
    ...target,
    route: (webRequest) => {
      const dispatch = Promise.resolve().then(() => target.route(webRequest));
      dispatches.add(dispatch);
      return dispatch.finally(() => dispatches.delete(dispatch));
    },
  };
  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (active >= capacity) {
      try {
        await writeWebResponse(
          jsonError(
            503,
            -32000,
            "HTTP request capacity is full; retry after pending dispatches finish",
          ),
          response,
          { closeConnection: true },
        );
      } catch {
        response.destroy();
      }
      return;
    }
    active += 1;
    let reserved = true;
    const release = (): void => {
      if (!reserved) return;
      reserved = false;
      active -= 1;
      request.off("end", release);
      request.off("close", release);
      response.off("close", release);
    };
    await serveNodeRequest(ownedTarget, request, response, (hasUnreadBody) => {
      if (!hasUnreadBody || request.destroyed || response.destroyed) {
        release();
        return;
      }
      // Connection: close takes effect only after the response ends. Retain
      // unread input even when that response is an indefinitely open stream.
      request.once("end", release);
      request.once("close", release);
      response.once("close", release);
    }).finally(release);
  };
  const drainDispatches = async (): Promise<void> => {
    while (dispatches.size > 0) await Promise.allSettled([...dispatches]);
  };
  return { handle, drainDispatches };
};

/** Serve one MCP server, plus plain routes, over streamable HTTP until closed. */
export const serveStreamableHttp = async (
  options: ServeStreamableHttpOptions,
): Promise<StreamableHttpServer> => {
  const { host, port, logger, routes = [], closeInstance = true } = options;
  // Scoped IPv6 literals bind but cannot be named in a URL; refuse them before anything exists.
  if (host.includes("%"))
    throw new StreamableHttpListenError(
      new Error(`scoped IPv6 bind address ${host} is not supported`),
    );
  // Loopback is classified from the address the listener binds, after it binds; the instance
  // is created after that, so a bind failure leaves nothing to clean up.
  let allowedHosts: string[] | undefined;
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
  const requests = createNodeRequestOwner(
    { route, origin: () => origin, logger },
    options.maxConcurrentDispatches ?? DEFAULT_MAX_CONCURRENT_DISPATCHES,
  );
  const prepareTransportShutdown = stagedClose([
    async () => {
      stopped = true;
      await closeHttpServer(httpServer);
    },
    () => slot?.prepareShutdown() ?? Promise.resolve(),
    requests.drainDispatches,
  ]);
  try {
    httpServer.listen(port, host);
    await once(httpServer, "listening");
  } catch (cause: unknown) {
    throw new StreamableHttpListenError(cause);
  }
  const bound = httpServer.address();
  let url: string;
  try {
    url = endpointUrl(bound);
    origin = new URL(url).origin;
  } catch (cause: unknown) {
    await prepareTransportShutdown().catch(() => undefined);
    throw new StreamableHttpListenError(cause);
  }
  allowedHosts = hostHeaderAllowlist(
    host,
    bound !== null && typeof bound === "object" ? bound.address : host,
  );
  httpServer.on("request", (request, response) => {
    void requests.handle(request, response);
  });
  // Bind failures already rejected the listening wait above; only later listener errors are reported.
  httpServer.on("error", (error) => options.onerror?.(error));
  let instance: RequestTrackingMcpServer;
  try {
    instance = await options.createMcpServer({ era: "legacy" });
  } catch (cause: unknown) {
    // A route may have been admitted while the asynchronous factory was pending.
    await prepareTransportShutdown().catch(() => undefined);
    throw cause;
  }
  protocolOf(instance).onerror = (error) =>
    logger?.warn({ error: error.message }, "MCP HTTP request rejected");
  const live = new McpSessionSlot(
    instance,
    logger,
    options.sessionDrainTimeoutMs,
  );
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
  const prepareShutdown = stagedClose([
    prepareTransportShutdown,
    () => live.close(),
  ]);
  const close = stagedClose([
    prepareShutdown,
    ...(closeInstance ? [() => instance.close()] : []),
  ]);
  return { url, prepareShutdown, close };
};

/** Stop accepting, drop open connections and release the port. */
const closeHttpServer = (
  httpServer: ReturnType<typeof createHttpServer>,
): Promise<void> => {
  // close() first, as Node documents: a connection accepted before it would otherwise miss the forced-close pass.
  const closed = new Promise<void>((resolve, reject) => {
    httpServer.close((error) =>
      error === undefined ? resolve() : reject(error),
    );
  });
  httpServer.closeAllConnections();
  return closed;
};

/** Translate one node:http exchange through `route`, logging a failure and answering it when headers are still open. */
const serveNodeRequest = async (
  target: NodeRequestTarget,
  request: IncomingMessage,
  response: ServerResponse,
  onDispatchSettled: (hasUnreadBody: boolean) => void,
): Promise<void> => {
  const { route, origin, logger } = target;
  // A reply sent before an incoming body was fully consumed leaves the rest on the socket, which
  // the bridged stream keeps paused; closing the connection after the reply releases it. The
  // incoming message decides (end of stream, not "body disturbed"), so a partially read upload
  // and a GET or HEAD that carried a body close too.
  const declaresBody =
    request.headers["content-length"] !== undefined ||
    request.headers["transfer-encoding"] !== undefined;
  let webRequest: Request | undefined;
  const unreadBody = (): boolean => declaresBody && !request.readableEnded;
  try {
    try {
      webRequest = toWebRequest(request, response, origin());
    } catch (cause: unknown) {
      // Fetch refuses methods such as TRACE that node:http accepts, and the bridge refuses
      // targets that are not origin-form paths; both are answered instead of thrown.
      const target = cause instanceof UnsupportedRequestTargetError;
      await writeWebResponse(
        jsonError(
          target ? 400 : 405,
          -32600,
          target
            ? "Unsupported request target"
            : `Unsupported method ${request.method ?? ""}`,
        ),
        response,
        { closeConnection: true },
      );
      return;
    }
    let webResponse: Response;
    try {
      webResponse = await route(webRequest);
    } finally {
      onDispatchSettled(unreadBody());
    }
    await writeWebResponse(webResponse, response, {
      closeConnection: unreadBody(),
    });
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
        { closeConnection: unreadBody() },
      ).catch(() => undefined);
  }
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
