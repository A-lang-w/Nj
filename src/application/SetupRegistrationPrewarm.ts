import { tmpdir } from "node:os";

import {
  execFileOutput,
  execFileOutputFailure,
} from "../process/ExecFileOutput.js";
import { inspectClientRegistrationCommand } from "./ClientRegistrationIdentity.js";

/**
 * Best-effort outcome of materializing the pinned package-runner cache entry.
 * A failure never blocks setup; the first client start then performs the
 * one-time install inside its own startup deadline.
 */
export type SetupRegistrationPrewarm =
  | { readonly status: "skipped"; readonly reason: "direct_launcher" }
  | { readonly status: "warmed" }
  | { readonly status: "failed"; readonly reason: string };

/** One cold package install at setup time; client startup deadlines stay untouched. */
const PREWARM_TIMEOUT_MS = 180_000;
const PREWARM_MAX_OUTPUT_BYTES = 64 * 1024;
const PREWARM_REASON_LIMIT = 300;

/** Spawn shape shared with execFileOutput so tests can observe the launch. */
export type RegistrationRunnerSpawn = (
  command: string,
  arguments_: readonly string[],
  options: {
    readonly timeout: number;
    readonly stopSignal: NodeJS.Signals;
    readonly maxBuffer: number;
    readonly env: Readonly<NodeJS.ProcessEnv>;
    /** Neutral directory; inside a REA source checkout the package runner
     * would resolve the local project instead of the published entry. */
    readonly cwd: string;
  },
) => Promise<unknown>;

/**
 * Resolve the cache-materializing variant of a registration command. The
 * package-runner cache entry is keyed by the requested spec, so a terminating
 * subcommand with the same spec warms the entry the client will launch.
 * Direct launchers keep no package-runner cache; they return undefined.
 */
export const registrationPrewarmCommand = (
  command: readonly string[],
): readonly string[] | undefined => {
  if (
    command.length === 0 ||
    command[command.length - 1] !== "mcp" ||
    inspectClientRegistrationCommand(command, undefined).package === undefined
  )
    return undefined;
  return [...command.slice(0, -1), "--version"];
};

/** Materialize the pinned package-runner cache entry once, best-effort. */
export const materializeRegistrationRunnerCache = async (
  command: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
  spawnCommand: RegistrationRunnerSpawn = execFileOutput,
): Promise<SetupRegistrationPrewarm> => {
  const prewarm = registrationPrewarmCommand(command);
  if (prewarm === undefined)
    return { status: "skipped", reason: "direct_launcher" };
  try {
    await spawnCommand(prewarm[0] ?? "", prewarm.slice(1), {
      timeout: PREWARM_TIMEOUT_MS,
      stopSignal: "SIGTERM",
      maxBuffer: PREWARM_MAX_OUTPUT_BYTES,
      env: environment,
      cwd: tmpdir(),
    });
    return { status: "warmed" };
  } catch (cause: unknown) {
    return { status: "failed", reason: prewarmFailureReason(cause) };
  }
};

const prewarmFailureReason = (cause: unknown): string => {
  const failure = execFileOutputFailure(cause);
  const observed =
    failure === undefined
      ? cause instanceof Error
        ? cause.message
        : String(cause)
      : `exit ${failure.code === null ? "unknown" : String(failure.code)}${
          failure.stderr.trim() === "" ? "" : `: ${failure.stderr.trim()}`
        }`;
  const normalized = observed
    .replace(/\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\([0-9A-Za-z]|[@-Z\\^_])/gu, "")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return `The pinned package-runner entry could not be materialized before the first client start (${normalized.slice(0, PREWARM_REASON_LIMIT)}); the first client start will install it inside its startup deadline.`;
};
