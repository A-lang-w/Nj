import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it, vi } from "vitest";

import { verifyNoTokenOwnedProcesses } from "../../../src/process/ProcessOwnership.js";
import { ProcessOwnershipEvidenceOwner } from "../../../src/process/ProcessOwnershipEvidence.js";
import { createSystemProcessOwnershipHost } from "../../../src/process/ProcessOwnershipObservation.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execFileAsync = promisify(execFile);

it.runIf(process.platform === "darwin")(
  "settles a native zombie whose token became unreadable after a live table snapshot",
  async () => {
    const directory = await createTestTempDirectory("rea-zombie-settlement-");
    const executable = join(directory, "hold-zombie");
    await execFileAsync("cc", [
      fileURLToPath(new URL("../../fixtures/processZombie.c", import.meta.url)),
      "-o",
      executable,
    ]);
    const host = createSystemProcessOwnershipHost("darwin", process.env);
    const signalGroup = vi.fn();
    const runId = `rea-zombie-${randomUUID()}`;
    try {
      await host.prepare?.();
      const holder = execFileAsync(executable, [], {
        env: { ...process.env, REA_PROCESS_RUN_ID: runId },
        timeout: 15_000,
      });
      const lines = createInterface({ input: holder.child.stdout! });
      const events = lines[Symbol.asyncIterator]();
      let pid: number | undefined;
      try {
        pid = Number((await events.next()).value);
        const row = (await host.listProcesses()).find(
          (entry) => entry.pid === pid,
        );
        if (row === undefined)
          throw new Error("Live fixture process was not listed");
        expect(row.state.startsWith("Z")).toBe(false);
        expect((await host.runTokens!([row])).get(pid)).toEqual({
          state: "readable",
          runId,
        });

        holder.child.stdin!.write("x");
        expect((await events.next()).value).toBe("zombie");
        expect((await host.processIdentities!([row])).get(pid)).toMatchObject({
          state: "readable",
          lifecycle: { state: "observed", lifecycle: "zombie" },
        });
        expect((await host.runTokens!([row])).get(pid)).toMatchObject({
          state: "unavailable",
        });

        // Replay the actual pre-exit table row; identities and tokens still
        // come from the native observer, with no timing race or provider mock.
        await expect(
          verifyNoTokenOwnedProcesses(
            runId,
            { ...host, listProcesses: async () => [row], signalGroup },
            [],
            {
              leaderPid: pid,
              processGroupId: row.processGroupId,
              evidenceOwner: new ProcessOwnershipEvidenceOwner(),
            },
          ),
        ).resolves.toEqual({ cleaned: true, signaled: false });
        expect(signalGroup).not.toHaveBeenCalled();
      } finally {
        holder.child.stdin!.end();
        await holder;
        lines.close();
        if (pid !== undefined)
          expect(
            (await host.listProcesses()).some((entry) => entry.pid === pid),
          ).toBe(false);
      }
    } finally {
      await host.close?.();
    }
  },
);
