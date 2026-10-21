import type { Writable } from "node:stream";
import { addAbortListener } from "node:events";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";

import { bufferedJsonParts, jsonParts } from "../domain/jsonSerialization.js";

type JsonOutputFormat = "json" | "jsonl";

/**
 * Write ordinary JSON without constructing a document-sized string.
 *
 * `json` is indented for a terminal reader. Piped or redirected output, which
 * agents and scripts consume, is compact: indentation adds no information and
 * measured 16-45% more model tokens on real results. The value is identical.
 */
export const writeJsonOutput = async (
  value: unknown,
  destination: Writable,
  format: JsonOutputFormat = "json",
  signal?: AbortSignal,
): Promise<void> => {
  for (const part of bufferedJsonParts(
    jsonOutputParts(value, format, isTerminal(destination)),
  ))
    await writeOutputText(destination, part, signal);
};

const isTerminal = (destination: Writable): boolean =>
  "isTTY" in destination && destination.isTTY === true;

export const writeOutputText = (
  destination: Writable,
  part: string,
  signal?: AbortSignal,
): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        new AnalysisCancelledError("write_output", { cause: signal.reason }),
      );
      return;
    }
    const cancellation =
      signal === undefined
        ? undefined
        : addAbortListener(signal, () => {
            // The writer abandons its wait, not the caller-owned destination.
            reject(
              new AnalysisCancelledError("write_output", {
                cause: signal.reason,
              }),
            );
          });
    const onError = (cause: unknown): void => {
      cancellation?.[Symbol.dispose]();
      reject(cause);
    };
    destination.once("error", onError);
    try {
      destination.write(part, (cause) => {
        cancellation?.[Symbol.dispose]();
        if (cause) {
          // A Writable can emit its error after invoking the write callback.
          setImmediate(() => destination.off("error", onError));
          reject(cause);
        } else {
          destination.off("error", onError);
          resolve();
        }
      });
    } catch (cause: unknown) {
      cancellation?.[Symbol.dispose]();
      destination.off("error", onError);
      reject(cause);
    }
  });

/** The exact formatted document, including its final newline. */
export function* jsonOutputParts(
  value: unknown,
  format: JsonOutputFormat,
  pretty = true,
): Generator<string> {
  if (format === "jsonl" && Array.isArray(value)) {
    for (const item of value) {
      yield* jsonParts(item);
      yield "\n";
    }
    return;
  }
  yield* jsonParts(value, pretty && format === "json");
  yield "\n";
}
