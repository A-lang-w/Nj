import type { JsonValue } from "../domain/jsonValue.js";
import { err, type Result } from "../domain/result.js";
import type { ProviderStartupDeadline } from "../process/ProviderDeadline.js";
import type { GhidraRequestOptions } from "./GhidraClientTypes.js";
import {
  GHIDRA_STARTUP_DEADLINE_ELAPSED,
  type GhidraSessionError,
  type GhidraSessionFailureFactory,
} from "./GhidraSessionError.js";
import type { GhidraSessionInfo } from "./GhidraSessionValues.js";

const ANALYSIS_POLL_INTERVAL_MS = 250;

/** Inputs needed to complete the post-connection bridge handshake. */
export interface GhidraStartupHandshakeOptions {
  readonly deadline: ProviderStartupDeadline;
  readonly request: (
    method: string,
    params: JsonValue,
    options: GhidraRequestOptions,
  ) => Promise<Result<JsonValue, GhidraSessionError>>;
  readonly parseSessionInfo: (
    value: JsonValue,
  ) => Result<GhidraSessionInfo, GhidraSessionError>;
  readonly failure: GhidraSessionFailureFactory;
  readonly startupTimeoutMs: number;
}

/** Poll the authenticated bridge until its owned analysis lifecycle is ready. */
export async function completeGhidraStartupHandshake(
  options: GhidraStartupHandshakeOptions,
): Promise<Result<GhidraSessionInfo, GhidraSessionError>> {
  while (!options.deadline.signal.aborted) {
    const ping = await requestSessionInfo(options);
    if (!ping.ok) return ping;

    if (ping.value.analysis_timed_out)
      return err(
        options.failure(
          "analysis_timeout",
          "Ghidra auto-analysis reached its per-file deadline",
        ),
      );
    if (ping.value.analysis_complete) return ping;

    const waited = await options.deadline.wait(ANALYSIS_POLL_INTERVAL_MS);
    if (waited === "aborted") break;
  }

  return err(interruptionFailure(options));
}

async function requestSessionInfo(
  options: GhidraStartupHandshakeOptions,
): Promise<Result<GhidraSessionInfo, GhidraSessionError>> {
  const ping = await options.request(
    "ping",
    {},
    {
      signal: options.deadline.signal,
      timeoutMs: options.deadline.remainingMs(),
    },
  );
  if (!ping.ok) {
    const failure =
      ping.error.kind === "cancelled" &&
      options.deadline.interruption !== undefined
        ? interruptionFailure(options)
        : ping.error;
    return err(failure);
  }

  return options.parseSessionInfo(ping.value);
}

const interruptionFailure = (
  options: GhidraStartupHandshakeOptions,
): GhidraSessionError =>
  options.deadline.interruption === "cancelled"
    ? options.failure(
        "cancelled",
        "Ghidra startup was cancelled",
        options.deadline.signal.reason,
        { cancellation: { reason: options.deadline.signal.reason } },
      )
    : options.failure("timeout", GHIDRA_STARTUP_DEADLINE_ELAPSED, undefined, {
        timeoutMs: options.startupTimeoutMs,
      });
