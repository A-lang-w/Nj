/** The phase and budget that own an observed firmware timeout. */
export interface FirmwareDeadline {
  readonly phase: "analysis" | "publication";
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

/** Keep a phase's selected budget paired with its cancellation identity. */
export const startFirmwareDeadline = (
  phase: FirmwareDeadline["phase"],
  timeoutMs: number,
): FirmwareDeadline => ({
  phase,
  signal: AbortSignal.timeout(timeoutMs),
  timeoutMs,
});
