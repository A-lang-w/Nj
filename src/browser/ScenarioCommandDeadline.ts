import { BrowserObservationError } from "../domain/browserObservationError.js";
import {
  cdpCommandDeadlineRecovery,
  selectedCdpCommandTimeoutMs,
  type CdpCommandDeadlinePhase,
} from "../domain/browserDeadline.js";
import type { BrowserScenario } from "../domain/browserScenario.js";

const OPERATION = "capture_browser_scenario" as const;

/** Selected scenario CDP deadline, or today's 20000 ms default when omitted. */
export const scenarioCommandTimeoutMs = (
  scenario: Pick<BrowserScenario, "command_timeout_ms">,
): number => selectedCdpCommandTimeoutMs(scenario.command_timeout_ms);

const playwrightTimedOut = (cause: unknown): cause is Error =>
  cause instanceof Error &&
  (cause.name === "TimeoutError" || cause.message.startsWith("Timeout "));

/**
 * Bound one Playwright CDP handshake or command by the scenario command deadline.
 * Playwright's own timeout, when it rejects first, is reported as that deadline.
 */
export const withScenarioCommandDeadline = async <T>(
  work: () => Promise<T>,
  timeoutMs: number,
  phase: Extract<CdpCommandDeadlinePhase, "handshake" | "command">,
  method?: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const recovery = (): {
    readonly userMessage: string;
    readonly remediationAction: string;
  } => cdpCommandDeadlineRecovery(timeoutMs, phase, method);
  try {
    return await new Promise<T>((resolve, reject) => {
      const fail = (cause: unknown): void => {
        if (settled) return;
        settled = true;
        reject(cause);
      };
      timer = setTimeout(() => {
        const deadline = recovery();
        fail(
          new BrowserObservationError(OPERATION, "timeout", {
            detail: deadline.userMessage,
            remediationAction: deadline.remediationAction,
          }),
        );
      }, timeoutMs);
      work().then(
        (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        },
        (cause: unknown) => {
          if (playwrightTimedOut(cause)) {
            const deadline = recovery();
            fail(
              new BrowserObservationError(OPERATION, "timeout", {
                detail: deadline.userMessage,
                remediationAction: deadline.remediationAction,
                cause,
              }),
            );
            return;
          }
          fail(cause);
        },
      );
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
