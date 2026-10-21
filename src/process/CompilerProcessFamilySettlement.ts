import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { EXEC_FILE_OUTPUT_STOP_GRACE_MS } from "./ExecFileOutput.js";
import { readBootstrapProcessTable } from "./BootstrapProcessTable.js";
import { PROCESS_CLEANUP_VERIFICATION_INTERVAL_MS } from "./ProcessLifecycle.js";
import type { ProcessTableEntry } from "./ProcessOwnership.js";
import { liveProcesses } from "./ProcessOwnershipProcessTree.js";

export const compilerFamilySettlementBudgetMs = (
  compileTimeoutMs: number,
): number =>
  Math.max(30_000, compileTimeoutMs) + EXEC_FILE_OUTPUT_STOP_GRACE_MS;

/**
 * Check if any member of the compiler's process group is still alive.
 * Use pgid instead of parent-child linkage because children are reparented
 * to init when the leader exits, but they keep the original process group.
 */
const compilerFamilyRemains = (
  leaderPid: number,
  processes: readonly ProcessTableEntry[],
): boolean => {
  // Leader still alive
  if (processes.some(({ pid }) => pid === leaderPid)) return true;
  // Any process in the compiler's process group (pgid == leaderPid) is still alive
  return processes.some(({ processGroupId }) => processGroupId === leaderPid);
};

/** Wait for a bootstrap-compiled command family to leave the process table. */
export const awaitBootstrapCompilerProcessFamilyExit = async (
  leaderPid: number,
  compileTimeoutMs: number,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<boolean> => {
  const deadline =
    performance.now() + compilerFamilySettlementBudgetMs(compileTimeoutMs);
  while (performance.now() < deadline) {
    signal.throwIfAborted();
    const processes = liveProcesses(
      await readBootstrapProcessTable(environment, signal),
    );
    if (!compilerFamilyRemains(leaderPid, processes)) return true;
    await delay(PROCESS_CLEANUP_VERIFICATION_INTERVAL_MS);
  }
  const processes = liveProcesses(
    await readBootstrapProcessTable(environment, signal),
  );
  return !compilerFamilyRemains(leaderPid, processes);
};
