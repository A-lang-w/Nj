import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SWIFTC_INTERRUPT } from "../process/DarwinProcessRunTokenReader.js";
import {
  execFileOutput,
  execFileOutputFailure,
} from "../process/ExecFileOutput.js";
import {
  awaitBootstrapCompilerProcessFamilyExit,
  compilerFamilySettlementBudgetMs,
} from "../process/CompilerProcessFamilySettlement.js";
import { safeParseJson } from "../domain/safeJson.js";
import type { NativeUiHelper } from "./NativeUiObservation.js";
import { NATIVE_UI_HELPER_MAX_BUFFER } from "./NativeUiOutputBudget.js";
import { NATIVE_UI_DEADLINE_MS } from "./NativeUiInterruptionControl.js";

const NATIVE_UI_COMPILE_TIMEOUT_MS = 60_000;

export interface NativeUiHelperRuntime {
  readonly invoke: NativeUiHelper;
  readonly cleanupLease: AnalysisCleanupLease;
  readonly signal: AbortSignal;
  close(): Promise<void>;
  resources(): readonly string[];
}

/** Lazily compile one owned helper per observation/scenario and remove its compiler cache. */
export const createNativeUiHelperRuntime = (
  environment: Readonly<NodeJS.ProcessEnv>,
): NativeUiHelperRuntime => {
  const selectedEnvironment = snapshotEnvironment(environment);
  const deadlineSignal = AbortSignal.timeout(NATIVE_UI_DEADLINE_MS);
  const operations = new ArtifactResourceScope();
  let root: string | undefined;
  let preparation: Promise<string> | undefined;
  // Track compiler failure metadata for family-exit waiting before cleanup
  let pendingCompilerFamily:
    | { leaderPid: number; environment: NodeJS.ProcessEnv }
    | undefined;
  const cleanupLease = new AnalysisCleanupLease(async () => {
    await operations.close();
    if (root !== undefined) {
      // Wait for compiler family to exit if output readers were cut off
      if (pendingCompilerFamily !== undefined) {
        const cleanupDeadline = AbortSignal.timeout(
          compilerFamilySettlementBudgetMs(NATIVE_UI_COMPILE_TIMEOUT_MS),
        );
        await awaitBootstrapCompilerProcessFamilyExit(
          pendingCompilerFamily.leaderPid,
          NATIVE_UI_COMPILE_TIMEOUT_MS,
          pendingCompilerFamily.environment,
          cleanupDeadline,
        );
        pendingCompilerFamily = undefined;
      }
      await rm(root, { recursive: true, force: true });
      root = undefined;
      preparation = undefined;
    }
  });
  const prepare = async (signal: AbortSignal): Promise<string> => {
    root = await mkdtemp(join(tmpdir(), "rea-native-ui-"));
    const output = join(root, "observer");
    const main = join(root, "main.swift");
    await symlink(
      fileURLToPath(
        new URL("../../bridge/native/ReaNativeUI.swift", import.meta.url),
      ),
      main,
    );
    // Keep swiftc's intermediate objects inside the removable root.
    const compilerTemporary = join(root, "tmp");
    await mkdir(compilerTemporary);
    const compilerEnvironment = {
      ...selectedEnvironment,
      TMPDIR: compilerTemporary,
    };
    try {
      await execFileOutput(
        "/usr/bin/xcrun",
        [
          "swiftc",
          "-module-cache-path",
          join(root, "modules"),
          fileURLToPath(
            new URL(
              "../../bridge/native/NativeUIChildren.swift",
              import.meta.url,
            ),
          ),
          main,
          "-o",
          output,
        ],
        {
          timeout: NATIVE_UI_COMPILE_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          stopSignal: SWIFTC_INTERRUPT,
          env: compilerEnvironment,
          signal,
        },
      );
    } catch (cause: unknown) {
      // Track compilation failure with output cutoff for family-exit waiting
      const failure = execFileOutputFailure(cause);
      if (
        failure?.outputReadersCutOff === true &&
        failure.leaderPid !== undefined
      ) {
        pendingCompilerFamily = {
          leaderPid: failure.leaderPid,
          environment: compilerEnvironment,
        };
      }
      throw cause;
    }
    return output;
  };
  const invoke: NativeUiHelper = (parameters, callerSignal) =>
    operations.run(async () => {
      const signal =
        callerSignal === undefined
          ? deadlineSignal
          : AbortSignal.any([callerSignal, deadlineSignal]);
      preparation ??= prepare(signal);
      const executable = await preparation;
      const output = await execFileOutput(
        executable,
        [JSON.stringify(parameters)],
        {
          timeout: 30_000,
          maxBuffer: NATIVE_UI_HELPER_MAX_BUFFER,
          stopSignal: "SIGTERM",
          env: selectedEnvironment,
          signal,
        },
      );
      const parsed = safeParseJson(output.stdout);
      if (!parsed.ok)
        throw new Error(
          `Native helper returned invalid JSON: ${parsed.error}`,
          {
            cause: parsed.cause,
          },
        );
      return parsed.value;
    });
  return {
    invoke,
    cleanupLease,
    signal: deadlineSignal,
    close: () => cleanupLease.release(),
    resources: () => (root === undefined ? [] : [root]),
  };
};
