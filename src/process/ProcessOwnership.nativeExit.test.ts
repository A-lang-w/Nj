import { expect, it, vi } from "vitest";
import {
  cleanupOwnedProcessGroup,
  verifyNoTokenOwnedProcesses,
  type ProcessIdentityObservation,
  type ProcessOwnershipHost,
  type ProcessTableEntry,
} from "./ProcessOwnership.js";
import { ProcessOwnershipEvidenceOwner } from "./ProcessOwnershipEvidence.js";

it.each(["zombie", "absent", "live", "unavailable"] as const)(
  "rechecks native lifetime when a token disappears during cleanup: %s",
  async (lifetimeAfterToken) => {
    const row: ProcessTableEntry = {
      pid: 100,
      parentPid: 1,
      processGroupId: 100,
      state: "S",
      command: "fixture",
    };
    let tokenRead = false;
    const identity = (): ProcessIdentityObservation => {
      if (tokenRead && lifetimeAfterToken === "absent")
        return { state: "absent", reason: "not-found-in-caller-pid-namespace" };
      if (tokenRead && lifetimeAfterToken === "unavailable")
        return { state: "unavailable", reason: "identity read denied" };
      return {
        state: "readable",
        identity: "same-generation",
        lifecycle: {
          state: "observed",
          lifecycle:
            tokenRead && lifetimeAfterToken === "zombie"
              ? "zombie"
              : "non-zombie",
        },
        relation: { state: "observed", parentPid: 1, processGroupId: 100 },
      };
    };
    const signalGroup = vi.fn();
    const host: ProcessOwnershipHost = {
      platform: "linux",
      listProcesses: async () => [row],
      environment: async () => ({}),
      runTokens: async (members) => {
        tokenRead = true;
        return new Map(
          members.map(({ pid }) => [
            pid,
            { state: "readable" as const, runId: undefined },
          ]),
        );
      },
      processIdentities: async (members) =>
        new Map(members.map(({ pid }) => [pid, identity()])),
      signalGroup,
    };
    const result = await cleanupOwnedProcessGroup(
      { runId: "run", leaderPid: 100, processGroupId: 100 },
      host,
    );
    expect(tokenRead).toBe(true);
    if (lifetimeAfterToken === "zombie" || lifetimeAfterToken === "absent") {
      expect(result).toEqual({ cleaned: true, signaled: false });
    } else {
      expect(result).toMatchObject({
        cleaned: false,
        failures: [
          {
            pid: 100,
            reason:
              lifetimeAfterToken === "live"
                ? "run-token-mismatch"
                : "process-identity-unavailable",
          },
        ],
      });
    }
    expect(signalGroup).not.toHaveBeenCalled();
  },
);

it.each([
  { discovery: "fresh", lifetime: "zombie" },
  { discovery: "retained-table-omitted", lifetime: "zombie" },
  { discovery: "retained-table-omitted", lifetime: "live" },
  { discovery: "retained-table-omitted", lifetime: "unavailable" },
  { discovery: "retained-table-omitted", lifetime: "replaced" },
  { discovery: "retained-table-omitted", lifetime: "unknown-lifecycle" },
] as const)(
  "settles swept $discovery candidates from native lifetime: $lifetime",
  async ({ discovery, lifetime }) => {
    const row: ProcessTableEntry = {
      pid: 100,
      parentPid: 1,
      processGroupId: 100,
      state: "S",
      command: "fixture",
    };
    const evidenceOwner = new ProcessOwnershipEvidenceOwner();
    const relation = { leaderPid: 100, processGroupId: 100, evidenceOwner };
    let settling = false;
    let tokenRead = false;
    const identity = (): ProcessIdentityObservation => {
      if (settling && tokenRead && lifetime === "unavailable")
        return { state: "unavailable", reason: "native identity denied" };
      return {
        state: "readable",
        identity:
          settling && tokenRead && lifetime === "replaced"
            ? "replacement-generation"
            : "same-generation",
        ...(settling && lifetime === "unknown-lifecycle"
          ? {}
          : {
              lifecycle: {
                state: "observed" as const,
                lifecycle:
                  settling &&
                  tokenRead &&
                  (lifetime === "zombie" || lifetime === "replaced")
                    ? ("zombie" as const)
                    : ("non-zombie" as const),
              },
            }),
        relation: { state: "observed", parentPid: 1, processGroupId: 100 },
      };
    };
    const signalGroup = vi.fn();
    const host: ProcessOwnershipHost = {
      listProcesses: async () =>
        settling && discovery === "retained-table-omitted" ? [] : [row],
      environment: async () => ({}),
      processIdentities: async (members) =>
        new Map(members.map(({ pid }) => [pid, identity()])),
      runTokens: async (members) => {
        tokenRead = true;
        return new Map(
          members.map(({ pid }) => [
            pid,
            !settling || lifetime === "replaced"
              ? { state: "readable" as const, runId: "run" }
              : { state: "unavailable" as const, reason: "sysctl_failed_22" },
          ]),
        );
      },
      signalGroup,
    };

    if (discovery === "retained-table-omitted") {
      await expect(
        verifyNoTokenOwnedProcesses("run", host, [], relation),
      ).resolves.toMatchObject({
        cleaned: false,
        reason: "token-owned process remained after cleanup",
      });
      expect(evidenceOwner.candidates).toMatchObject([
        { pid: row.pid, applicability: "token-verified" },
      ]);
    }
    settling = true;
    tokenRead = false;
    const result = await verifyNoTokenOwnedProcesses("run", host, [], relation);

    if (lifetime === "zombie") {
      expect(result).toEqual({ cleaned: true, signaled: false });
      expect(evidenceOwner.candidates).toEqual([]);
    } else {
      expect(result).toMatchObject({
        cleaned: false,
        failures: [
          {
            pid: row.pid,
            reason:
              lifetime === "unavailable" || lifetime === "replaced"
                ? "process-identity-unavailable"
                : "environment-unreadable",
          },
        ],
      });
    }
    expect(tokenRead).toBe(true);
    expect(signalGroup).not.toHaveBeenCalled();
  },
);
