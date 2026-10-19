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

it.each(
  [
    "zombie",
    "live",
    "unavailable",
    "lifecycle-unavailable",
    "replaced",
    "unavailable-zombie",
  ].flatMap((lifetime) =>
    [true, false].flatMap((related) =>
      [null, "prior-generation"].map((baseline) => ({
        lifetime,
        related,
        baseline,
      })),
    ),
  ),
)(
  "settles token sweeps from native lifetime: $lifetime, related=$related, baseline=$baseline",
  async ({ lifetime, related, baseline }) => {
    const row: ProcessTableEntry = {
      pid: 900,
      parentPid: related ? 100 : 1,
      processGroupId: related ? 100 : 900,
      state: "S",
      command: "token-sweep-fixture",
    };
    let tokenRead = false;
    let identityReads = 0;
    const identity = (): ProcessIdentityObservation => {
      identityReads += 1;
      if (
        tokenRead &&
        (lifetime === "unavailable" ||
          (lifetime === "unavailable-zombie" && identityReads % 2 === 1))
      )
        return { state: "unavailable", reason: "identity read denied" };
      return {
        state: "readable",
        identity:
          lifetime === "replaced" ? String(identityReads) : "same-generation",
        lifecycle:
          tokenRead && lifetime === "lifecycle-unavailable"
            ? { state: "unavailable", reason: "lifecycle read denied" }
            : {
                state: "observed",
                lifecycle:
                  tokenRead &&
                  ["zombie", "replaced", "unavailable-zombie"].includes(
                    lifetime,
                  )
                    ? "zombie"
                    : "non-zombie",
              },
        relation: {
          state: "observed",
          parentPid: row.parentPid,
          processGroupId: row.processGroupId,
        },
      };
    };
    const signalGroup = vi.fn();
    const evidenceOwner = new ProcessOwnershipEvidenceOwner();
    const host: ProcessOwnershipHost = {
      platform: "linux",
      listProcesses: async () => [row],
      environment: async () => ({}),
      processIdentities: async (members) =>
        new Map(members.map(({ pid }) => [pid, identity()])),
      runTokens: async (members) => {
        tokenRead = true;
        return new Map(
          members.map(({ pid }) => [
            pid,
            {
              state: "unavailable" as const,
              reason: "EACCES: permission denied",
            },
          ]),
        );
      },
      signalGroup,
    };
    const result = await verifyNoTokenOwnedProcesses(
      "run-token",
      host,
      [{ pid: row.pid, identity: baseline }],
      { leaderPid: 100, processGroupId: 100, evidenceOwner },
    );
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
              lifetime === "unavailable" ||
              lifetime === "unavailable-zombie" ||
              lifetime === "replaced"
                ? "process-identity-unavailable"
                : "environment-unreadable",
          },
        ],
      });
      if (related) expect(evidenceOwner.candidates).toHaveLength(1);
    }
    expect(signalGroup).not.toHaveBeenCalled();
  },
);
