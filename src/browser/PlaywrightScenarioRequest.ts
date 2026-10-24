import type { Page } from "playwright-core";

import type {
  BrowserScenarioAction,
  BrowserScenarioRequestHeader,
} from "../domain/browserScenarioValues.js";
import type { BrowserScenarioSecrets } from "./BrowserScenarioSecrets.js";

type RequestAction = Extract<BrowserScenarioAction, { action: "request" }>;

/** What the page's fetch returned. */
interface PageResponse {
  readonly status: number;
}

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
    const stored = await page.evaluate(
      (key) =>
        (
          globalThis as {
            readonly localStorage?: { getItem(key: string): string | null };
          }
        ).localStorage?.getItem(key) ?? null,
      value.key,
    );
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
}): Promise<void> => {
  const { page, action, secrets, startOrigin } = input;
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
  for (const { name, value } of action.query)
    url.searchParams.append(name, secrets.value(value));
  const step = { page, url, stepId: action.step_id, secrets };
  const headers: [string, string][] = [];
  for (const header of action.headers)
    headers.push([
      header.name,
      `${header.prefix ?? ""}${await headerValue(step, header)}`,
    ]);
  const hasContentType = headers.some(
    ([name]) => name.toLowerCase() === "content-type",
  );
  if (action.json !== undefined && !hasContentType)
    headers.push(["content-type", "application/json"]);
  const response = await page.evaluate(
    async (request): Promise<PageResponse | { readonly error: string }> => {
      const controller = new AbortController();
      const timer =
        request.timeoutMs === undefined
          ? undefined
          : setTimeout(() => controller.abort(), request.timeoutMs);
      try {
        const answer = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          credentials: "same-origin",
          signal: controller.signal,
          ...(request.body === undefined ? {} : { body: request.body }),
        });
        await answer.arrayBuffer();
        return { status: answer.status };
      } catch (cause: unknown) {
        return {
          error: cause instanceof Error ? cause.message : String(cause),
        };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    {
      url: url.href,
      method: action.method,
      headers,
      body: action.json === undefined ? undefined : JSON.stringify(action.json),
      timeoutMs: action.timeout_ms,
    },
  );
  if ("error" in response)
    throw new ScenarioRequestError(
      `Request step ${action.step_id} failed in the page: ${response.error}`,
    );
  if (
    action.expected_status !== undefined &&
    !action.expected_status.includes(response.status)
  )
    throw new ScenarioRequestError(
      `Request step ${action.step_id} answered ${String(response.status)}; expected ${action.expected_status.join(" or ")}.`,
    );
};
