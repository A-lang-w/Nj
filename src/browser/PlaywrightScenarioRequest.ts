import type { Page } from "playwright-core";

import {
  HEADER_FIELD_VALUE,
  type BrowserScenarioAction,
  type BrowserScenarioRequestHeader,
} from "../domain/browserScenarioValues.js";
import type { BrowserScenarioSecrets } from "./BrowserScenarioSecrets.js";

type RequestAction = Extract<BrowserScenarioAction, { action: "request" }>;

/** What the page's fetch returned; a redirect is not followed, so its status is unknown. */
type PageResponse =
  | { readonly status: number }
  | { readonly redirected: true }
  | { readonly left: string }
  | { readonly error: string }
  | { readonly expired: true }
  | { readonly late: true };

/** How long after the step hands the page its request the page may still start it; a later start sends nothing and is handed over again. */
const SEND_START_WINDOW_MS = 1_000;

/** A request step that could not be sent or did not answer as expected. */
export class ScenarioRequestError extends Error {
  override readonly name = "ScenarioRequestError";
}

const originOf = (url: string): string | undefined => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

/** The string or number at a JSON pointer, as text. */
const pointerText = (value: unknown, pointer: string): string | undefined => {
  let current = value;
  if (pointer !== "")
    for (const token of pointer.slice(1).split("/")) {
      const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
      if (Array.isArray(current) && /^(?:0|[1-9][0-9]*)$/u.test(key))
        current = current[Number(key)];
      else if (
        typeof current === "object" &&
        current !== null &&
        Object.hasOwn(current, key)
      )
        current = (current as Record<string, unknown>)[key];
      else return undefined;
    }
  return typeof current === "string" || typeof current === "number"
    ? String(current)
    : undefined;
};

/** Resolve one header value; values read from the page are redacted from later records. */
const headerValue = async (
  step: {
    readonly page: Page;
    readonly url: URL;
    readonly stepId: string;
    readonly secrets: BrowserScenarioSecrets;
  },
  header: BrowserScenarioRequestHeader,
): Promise<string> => {
  const { page, url, stepId, secrets } = step;
  const { value } = header;
  if (value.source === "literal" || value.source === "secret")
    return secrets.value(value);
  let read: string | undefined;
  if (value.source === "cookie") {
    const cookies = await page.context().cookies(url.href);
    read = cookies.find((cookie) => cookie.name === value.name)?.value;
    if (read === undefined)
      throw new ScenarioRequestError(
        `Request step ${stepId}: cookie ${value.name} is not set for ${url.origin}.`,
      );
  } else {
    // Read only on the start origin: the page may have moved while earlier values were read.
    const fromPage = await page.evaluate(
      ({ key, origin }) => {
        const scope = globalThis as {
          readonly location?: { origin: string };
          readonly localStorage?: { getItem(key: string): string | null };
        };
        return scope.location?.origin === origin
          ? { stored: scope.localStorage?.getItem(key) ?? null }
          : { left: true as const };
      },
      { key: value.key, origin: url.origin },
    );
    if ("left" in fromPage)
      throw new ScenarioRequestError(
        `Request step ${stepId} runs from a page on the start origin ${url.origin}; the page moved while header values were read.`,
      );
    const { stored } = fromPage;
    if (stored === null)
      throw new ScenarioRequestError(
        `Request step ${stepId}: local storage has no ${value.key} on ${url.origin}.`,
      );
    if (value.json_pointer === undefined) read = stored;
    else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(stored);
      } catch {
        throw new ScenarioRequestError(
          `Request step ${stepId}: local storage ${value.key} is not JSON.`,
        );
      }
      read = pointerText(parsed, value.json_pointer);
      if (read === undefined)
        throw new ScenarioRequestError(
          `Request step ${stepId}: local storage ${value.key} has no string or number at ${value.json_pointer}.`,
        );
    }
  }
  secrets.admitPageValue(`${stepId}.${header.name}`, read);
  return read;
};

/** Append declared query entries after any literal query the path carries, leaving that query as written. */
const withQuery = (
  url: URL,
  entries: readonly (readonly [string, string])[],
): string => {
  if (entries.length === 0) return url.href;
  const added = entries
    .map(
      ([name, value]) =>
        `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    )
    .join("&");
  // fetch drops the fragment; cut it at its "#" even when nothing follows it.
  const hash = url.href.indexOf("#");
  const base = hash < 0 ? url.href : url.href.slice(0, hash);
  const separator = !base.includes("?")
    ? "?"
    : base.endsWith("?") || base.endsWith("&")
      ? ""
      : "&";
  return `${base}${separator}${added}`;
};

/** What a request step sends: the URL, the origin it must be sent from, and the call. */
interface PageRequest {
  readonly url: string;
  readonly origin: string;
  readonly method: string;
  readonly headers: [string, string][];
  readonly body: string | undefined;
  /** Epoch milliseconds the step's time runs out at, on the clock the page shares with this host. */
  readonly deadline: number | undefined;
}

/** Send the request with the page's own fetch, from the page's main world, and read the whole answer. */
const sendFromPage = (
  page: Page,
  request: PageRequest & { readonly startBy: number },
): Promise<PageResponse> =>
  page.evaluate(async (request): Promise<PageResponse> => {
    // The page may have navigated since the origin check; never send from another origin.
    const here = (globalThis as { readonly location?: { origin: string } })
      .location?.origin;
    if (here !== request.origin) return { left: String(here) };
    // A busy page may run this late; past the step's deadline or its hand-over window it sends nothing.
    const startedAt = Date.now();
    if (request.deadline !== undefined && startedAt >= request.deadline)
      return { expired: true };
    if (startedAt > request.startBy) return { late: true };
    const controller = new AbortController();
    const timer =
      request.deadline === undefined
        ? undefined
        : setTimeout(() => controller.abort(), request.deadline - startedAt);
    try {
      const answer = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        credentials: "same-origin",
        redirect: "manual",
        signal: controller.signal,
        ...(request.body === undefined ? {} : { body: request.body }),
      });
      // Wait for the whole response, dropping each chunk instead of keeping the body.
      const reader = answer.body?.getReader();
      if (reader !== undefined) {
        let chunk = await reader.read();
        while (!chunk.done) chunk = await reader.read();
      }
      return answer.type === "opaqueredirect"
        ? { redirected: true }
        : { status: answer.status };
    } catch (cause: unknown) {
      return {
        error: cause instanceof Error ? cause.message : String(cause),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }, request);

const outOfTime = (stepId: string): ScenarioRequestError =>
  new ScenarioRequestError(
    `Request step ${stepId} ran out of time before its request was sent.`,
  );

/** Hand the page its request until it starts it within the window; a cancelled or timed-out step hands nothing over. */
const sendWithinWindow = async (
  page: Page,
  request: PageRequest,
  step: { readonly stepId: string; readonly signal: AbortSignal | undefined },
): Promise<Exclude<PageResponse, { expired: true } | { late: true }>> => {
  const { deadline } = request;
  for (;;) {
    if (
      step.signal?.aborted === true ||
      (deadline !== undefined && Date.now() >= deadline)
    )
      throw outOfTime(step.stepId);
    const handedAt = Date.now();
    const response = await sendFromPage(page, {
      ...request,
      startBy: handedAt + SEND_START_WINDOW_MS,
    });
    if ("expired" in response) throw outOfTime(step.stepId);
    if (!("late" in response)) return response;
    // The page cannot have started late before the window passed here, unless its clock runs ahead.
    if (Date.now() - handedAt <= SEND_START_WINDOW_MS)
      throw new ScenarioRequestError(
        `Request step ${step.stepId}: the browser's clock runs ahead of this host's, so the step cannot tell when the page started its request; nothing was sent.`,
      );
  }
};

/**
 * Send one request from the page with its own fetch, cookies and session, as
 * the application's frontend would, and read the whole response so the
 * capture can record it. The page must be on the scenario's start origin.
 */
export const performScenarioRequest = async (input: {
  readonly page: Page;
  readonly action: RequestAction;
  readonly secrets: BrowserScenarioSecrets;
  readonly startOrigin: string;
  readonly signal?: AbortSignal | undefined;
}): Promise<void> => {
  const { page, action, secrets, startOrigin, signal } = input;
  const deadline =
    action.timeout_ms === undefined
      ? undefined
      : Date.now() + action.timeout_ms;
  const pageOrigin = originOf(page.url());
  if (pageOrigin !== startOrigin)
    throw new ScenarioRequestError(
      `Request step ${action.step_id} runs from a page on the start origin ${startOrigin}; navigate back to it with a goto step first.`,
    );
  const url = new URL(action.path, startOrigin);
  if (url.origin !== startOrigin)
    throw new ScenarioRequestError(
      `Request step ${action.step_id} must stay on the start origin ${startOrigin}.`,
    );
  const target = withQuery(
    url,
    action.query.map(({ name, value }) => [name, secrets.value(value)]),
  );
  const step = { page, url, stepId: action.step_id, secrets };
  const headers: [string, string][] = [];
  for (const header of action.headers) {
    const value = `${header.prefix ?? ""}${await headerValue(step, header)}`;
    if (!HEADER_FIELD_VALUE.test(value))
      throw new ScenarioRequestError(
        `Request step ${action.step_id}: the ${header.name} value holds characters a header cannot carry, such as a line break.`,
      );
    headers.push([header.name, value]);
  }
  const hasContentType = headers.some(
    ([name]) => name.toLowerCase() === "content-type",
  );
  if (action.json !== undefined && !hasContentType)
    headers.push(["content-type", "application/json"]);
  const response = await sendWithinWindow(
    page,
    {
      url: target,
      origin: startOrigin,
      method: action.method,
      headers,
      body: action.json === undefined ? undefined : JSON.stringify(action.json),
      deadline,
    },
    { stepId: action.step_id, signal },
  );
  if ("error" in response)
    throw new ScenarioRequestError(
      `Request step ${action.step_id} failed in the page: ${response.error}`,
    );
  if ("left" in response)
    throw new ScenarioRequestError(
      `Request step ${action.step_id} runs from a page on the start origin ${startOrigin}; the page moved before the request was sent.`,
    );
  if ("redirected" in response)
    throw new ScenarioRequestError(
      `Request step ${action.step_id} was answered with a redirect, which request steps do not follow; a write may already have been applied. The capture records the redirect and, with header values selected, its Location.`,
    );
  if (
    action.expected_status !== undefined &&
    !action.expected_status.includes(response.status)
  )
    throw new ScenarioRequestError(
      `Request step ${action.step_id} answered ${String(response.status)}; expected ${action.expected_status.join(" or ")}.`,
    );
};
