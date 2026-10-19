import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

/** Fetch rejects a body on these methods, so their request streams are not forwarded. */
const BODYLESS_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/** The request target was not an origin-form path; the bridge serves an origin server only. */
export class UnsupportedRequestTargetError extends Error {
  override readonly name = "UnsupportedRequestTargetError";
  constructor(target: string) {
    super(`Unsupported request target ${target}`);
  }
}

/** Join an origin-form target onto the listener's origin verbatim, so `//host/path` stays a path and a path that URL parsing would rewrite (dot segments) is refused rather than routed elsewhere. */
const requestUrl = (target: string, origin: string): URL => {
  if (!target.startsWith("/")) throw new UnsupportedRequestTargetError(target);
  const url = new URL(`${origin}${target}`);
  const rawPath = target.split("?")[0] ?? "";
  if (url.pathname !== rawPath) throw new UnsupportedRequestTargetError(target);
  return url;
};

const toHeaders = (incoming: IncomingMessage["headers"]): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (Array.isArray(value))
      for (const entry of value) headers.append(name, entry);
    else headers.set(name, value);
  }
  return headers;
};

/** Translate a node:http request into a web Request whose signal aborts when the client leaves. */
export const toWebRequest = (
  request: IncomingMessage,
  response: ServerResponse,
  origin: string,
): Request => {
  const controller = new AbortController();
  response.once("close", () => {
    if (!response.writableFinished) controller.abort();
  });
  const method = request.method ?? "GET";
  return new Request(requestUrl(request.url ?? "/", origin), {
    method,
    headers: toHeaders(request.headers),
    signal: controller.signal,
    ...(BODYLESS_METHODS.has(method)
      ? {}
      : { body: Readable.toWeb(request), duplex: "half" }),
  });
};

/** Header fields for writeHead; repeated Set-Cookie values survive as one array. */
const responseHeaders = (
  headers: Headers,
  closeConnection: boolean,
): Record<string, string | string[]> => {
  const fields: Record<string, string | string[]> = {};
  for (const [name, value] of headers)
    if (name !== "set-cookie") fields[name] = value;
  const cookies = headers.getSetCookie();
  if (cookies.length > 0) fields["set-cookie"] = cookies;
  if (closeConnection) fields.connection = "close";
  return fields;
};

/** Copy a body into the reply chunk by chunk with backpressure; when the client leaves, cancel the body without waiting, since a teed body's cancellation settles only with its sibling. */
const pumpBody = async (
  body: ReadableStream<Uint8Array>,
  target: ServerResponse,
): Promise<void> => {
  const reader = body.getReader();
  const gone = new Promise<undefined>((resolve) => {
    target.once("close", () => resolve(undefined));
  });
  let next = await Promise.race([reader.read(), gone]);
  while (next !== undefined && !next.done) {
    if (!target.write(next.value))
      await Promise.race([once(target, "drain"), gone]);
    next = await Promise.race([reader.read(), gone]);
  }
  if (next === undefined) {
    void reader.cancel().catch(() => undefined);
    return;
  }
  target.end();
};

/** Stream a web Response into node:http, flushing headers and each chunk as it arrives; `closeConnection` ends the socket after this reply. A HEAD reply ends after the headers and cancels any body the route attached. */
export const writeWebResponse = async (
  response: Response,
  target: ServerResponse,
  options: { readonly closeConnection?: boolean } = {},
): Promise<void> => {
  target.writeHead(
    response.status,
    responseHeaders(response.headers, options.closeConnection ?? false),
  );
  target.flushHeaders();
  if (response.body === null || target.req.method === "HEAD") {
    target.end();
    // Not awaited: cancelling one branch of a teed body settles only once its sibling is consumed or cancelled too.
    void response.body?.cancel().catch(() => undefined);
    return;
  }
  await pumpBody(response.body, target);
};
