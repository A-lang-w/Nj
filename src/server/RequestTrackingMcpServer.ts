import {
  McpServer,
  type Icon,
  type RegisteredTool,
  type ServerContext,
  type ScopeChallengeHandler,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
  type ToolCallback,
} from "@modelcontextprotocol/server";

/** Owns tool completion independently of transport cancellation and suppressed replies. */
export class RequestTrackingMcpServer extends McpServer {
  readonly #calls = new Set<Promise<unknown>>();

  override registerTool<
    OutputArgs extends StandardSchemaWithJSON,
    InputArgs extends StandardSchemaWithJSON | undefined = undefined,
  >(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: InputArgs;
      outputSchema?: OutputArgs;
      annotations?: ToolAnnotations;
      icons?: Icon[];
      scopeChallenge?: ScopeChallengeHandler;
      _meta?: Record<string, unknown>;
    },
    callback: ToolCallback<InputArgs>,
  ): RegisteredTool {
    // The SDK calls a schema-less callback with context alone, and a schema'd
    // callback with (validated input, context). Narrow its conditional type at
    // the same inputSchema discriminant used by the SDK.
    const tracked =
      config.inputSchema === undefined
        ? (context: ServerContext) =>
            this.#track(context, () =>
              (callback as ToolCallback<undefined>)(context),
            )
        : (args: unknown, context: ServerContext) =>
            this.#track(context, () =>
              (callback as ToolCallback<StandardSchemaWithJSON>)(args, context),
            );
    return super.registerTool<OutputArgs, InputArgs>(
      name,
      config,
      tracked as ToolCallback<InputArgs>,
    );
  }

  #track<T>(
    context: ServerContext,
    callback: () => T | Promise<T>,
  ): Promise<T> {
    // SDK validation can finish after its transport closed. Such a callback
    // must never start work against the next session's shared resources.
    const call = Promise.resolve().then(() => {
      context.mcpReq.signal.throwIfAborted();
      return callback();
    });
    this.#calls.add(call);
    return call.finally(() => this.#calls.delete(call));
  }

  /** Wait for running handlers, including their finally blocks; a timeout retains ownership. */
  async drainToolCalls(timeoutMs: number): Promise<boolean> {
    if (this.#calls.size === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.allSettled(this.#calls).then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
