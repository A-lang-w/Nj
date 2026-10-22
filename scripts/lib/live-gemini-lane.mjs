import assert from "node:assert/strict";

/** Google's public Gemini API root; callers may select a compatible endpoint. */
export const DEFAULT_GEMINI_BASE_URL =
  "https://generativelanguage.googleapis.com";

/**
 * A live-lane failure with a caller-actionable classification.
 *
 * The classification keeps transport, credential and contract failures apart so
 * a receipt never reports a blocked network as a client compatibility result.
 */
export class LiveLaneError extends Error {
  constructor(kind, message, detail) {
    super(message);
    this.name = "LiveLaneError";
    this.kind = kind;
    this.detail = detail;
  }
}

/** Credential sources checked in order; the selected name is recorded, never the value. */
const CREDENTIAL_SOURCES = ["REA_GEMINI_API_KEY", "GEMINI_API_KEY"];

/** Statuses Google returns for a missing, invalid or unauthorized key. */
const CREDENTIAL_STATUSES = new Set([400, 401, 403]);

/** Select the caller's live credential without echoing or persisting it. */
export const readLiveCredential = () => {
  for (const source of CREDENTIAL_SOURCES) {
    const value = process.env[source]?.trim();
    if (value !== undefined && value.length > 0) return { key: value, source };
  }
  throw new LiveLaneError(
    "missing_api_key",
    `No live Gemini credential. Export ${CREDENTIAL_SOURCES.join(" or ")} and rerun.`,
  );
};

/** Remove every credential occurrence before an artifact leaves the process. */
export const redact = (text, key) =>
  key === undefined || key.length === 0
    ? text
    : text.split(key).join("<redacted-gemini-credential>");

const truncate = (text, limit = 400) =>
  text.length <= limit ? text : `${text.slice(0, limit)}…`;

/**
 * Separate an unreachable transport from a rejected credential before spending
 * model tokens. `status === 0` means the request never completed.
 */
export const probeGeminiEndpoint = async ({ baseUrl, key, timeoutMs }) => {
  const root = baseUrl.replace(/\/+$/u, "");
  try {
    const response = await fetch(`${root}/v1beta/models`, {
      headers: { "x-goog-api-key": key },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      baseUrl: root,
      reachable: response.ok,
      status: response.status,
      detail: truncate(await response.text()),
    };
  } catch (cause) {
    return {
      baseUrl: root,
      reachable: false,
      status: 0,
      detail: truncate(
        `${cause?.name ?? "Error"}: ${cause?.message ?? "request failed"}`,
      ),
    };
  }
};

/**
 * Fail fast only for an unreachable transport or a rejected credential. Any
 * other status is recorded in the receipt and left to the client run, because a
 * caller may select a compatible endpoint that does not list models.
 */
export const classifyProbeFailure = (probe) => {
  if (probe.reachable) return undefined;
  if (probe.status === 0) return "network_unreachable";
  return CREDENTIAL_STATUSES.has(probe.status)
    ? "credential_rejected"
    : undefined;
};

const UNTRUSTED_PREFIX = "<untrusted_context>\n";
const UNTRUSTED_SUFFIX = "\n</untrusted_context>";

/** REA marks forwarded tool results untrusted; strip the envelope to read them. */
const unwrapToolOutput = (text) =>
  text.startsWith(UNTRUSTED_PREFIX) && text.endsWith(UNTRUSTED_SUFFIX)
    ? text.slice(UNTRUSTED_PREFIX.length, -UNTRUSTED_SUFFIX.length)
    : text;

/** Parse the client's newline-delimited stream, keeping line numbers for failures. */
export const parseClientEvents = (stdout) =>
  stdout
    .split("\n")
    .flatMap((line, index) => {
      if (line.trim() === "") return [];
      try {
        return [{ index, event: JSON.parse(line) }];
      } catch (cause) {
        throw new LiveLaneError(
          "unparsable_client_event",
          `Client stream line ${index + 1} is not JSON.`,
          `${line}\n${String(cause)}`,
        );
      }
    })
    .map(({ event }) => event);

/** Decode one JSON tool result, or `undefined` when it is not JSON evidence. */
const decodeToolOutput = (output) => {
  if (typeof output !== "string" || output.trim() === "") return undefined;
  try {
    return JSON.parse(unwrapToolOutput(output));
  } catch {
    return undefined;
  }
};

/** Collect the facts a live receipt reports about one completed client run. */
export const summarizeClientEvents = (events) => {
  const toolCalls = events
    .filter((event) => event.type === "tool_use")
    .map((event) => ({ name: event.tool_name, id: event.tool_id }));
  const results = new Map(
    events
      .filter((event) => event.type === "tool_result")
      .map((event) => [event.tool_id, event]),
  );
  const assistantText = events
    .filter((event) => event.type === "message" && event.role === "assistant")
    .map((event) => event.content)
    .filter((content) => typeof content === "string")
    .join("\n");
  return {
    model: events.find((event) => event.type === "init")?.model,
    sessionId: events.find((event) => event.type === "init")?.session_id,
    toolCalls,
    results,
    assistantText,
    result: events.findLast((event) => event.type === "result"),
  };
};

/** Require the live model to reach a named REA tool and return its output. */
export const requireToolEvidence = (summary, toolSuffix) => {
  const call = summary.toolCalls.find((item) => item.name.endsWith(toolSuffix));
  if (call === undefined)
    throw new LiveLaneError(
      "tool_not_called",
      `The live model never called a REA tool ending with ${toolSuffix}.`,
      `Called: ${summary.toolCalls.map((item) => item.name).join(", ") || "none"}`,
    );
  const result = summary.results.get(call.id);
  assert.equal(
    result?.status,
    "success",
    `${call.name}: live client reported a failed tool result`,
  );
  return { call, result, decoded: decodeToolOutput(result.output) };
};
