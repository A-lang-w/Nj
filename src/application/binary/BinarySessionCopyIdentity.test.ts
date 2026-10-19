import { describe, expect, it } from "vitest";

import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisProviderCandidate,
  type CapabilityDescriptor,
  type ProviderAvailability,
  type ProviderIdentity,
  type ProviderTargetSupport,
} from "../AnalysisProvider.js";
import { createAnalysisProfile } from "../../domain/analysisProfile.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import type { ProviderOperationHealth } from "../../domain/providerOperationHealth.js";
import { err, ok } from "../../domain/result.js";
import { InvestigationRecords } from "../investigation/InvestigationRecords.js";
import { AnalysisProviderRegistry } from "./AnalysisProviderRegistry.js";
import { BinarySession } from "./BinarySession.js";
import { SessionProviderRouter } from "./SessionProviderRouter.js";

/**
 * Regression coverage for the existing-project copy lifetime: a provider may
 * copy externally owned analysis state (a saved project) for every client it
 * starts. A dead-client restart must therefore recommit the profile that binds
 * cached answers to that copy instead of replaying results from the retired
 * one, while an unchanged recommitment keeps replay available.
 */
describe("BinarySession replacement client identity", () => {
  it("does not replay answers cached for a copy the restart replaced", async () => {
    const fixture = openSession((resolution) =>
      copyProfile(`copy-${resolution}`),
    );
    expect((await fixture.session.open(process.execPath)).ok).toBe(true);
    expect(await addressName(fixture.session)).toBe("copy-1");

    fixture.created[0]?.kill();
    expect((await fixture.session.open(process.execPath)).ok).toBe(true);

    // The replacement client copied the saved project again; its answer must
    // be observed, not replayed from the retired copy.
    expect(await addressName(fixture.session)).toBe("copy-2");
    expect(fixture.created).toHaveLength(2);
    expect(fixture.resolutions()).toBe(2);
  });

  it("keeps replaying answers when a restart recommits the same profile", async () => {
    const fixture = openSession(() => copyProfile("stable"));
    expect((await fixture.session.open(process.execPath)).ok).toBe(true);
    expect(await addressName(fixture.session)).toBe("copy-1");

    fixture.created[0]?.kill();
    expect((await fixture.session.open(process.execPath)).ok).toBe(true);

    const replayed = await fixture.session.execute("address_name", {
      address: "0x1000",
      document: "fixture",
    });
    if (!replayed.ok) throw replayed.error;
    expect(replayed.value.result).toBe("copy-1");
    expect(replayed.value.limitations.join(" ")).toContain(
      "Loaded from a local REA analysis snapshot",
    );
    // An unchanged identity keeps the copy's cached answers valid.
    expect(fixture.created).toHaveLength(1);
    expect(fixture.created[0]?.addressCalls).toBe(1);
  });

  it("refuses a replacement client that cannot recommit its identity", async () => {
    let resolutions = 0;
    const fixture = openSession(() => {
      resolutions += 1;
      return copyProfile(`copy-${resolutions}`, resolutions === 1 ? "1" : "2");
    });
    expect((await fixture.session.open(process.execPath)).ok).toBe(true);
    expect(await addressName(fixture.session)).toBe("copy-1");

    fixture.created[0]?.kill();
    const reopened = await fixture.session.open(process.execPath);
    expect(reopened).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCapabilityUnavailableError" },
    });
    expect(fixture.created).toHaveLength(1);
  });
});

const addressName = async (session: BinarySession): Promise<unknown> => {
  const result = await session.execute("address_name", {
    address: "0x1000",
    document: "fixture",
  });
  if (!result.ok) throw result.error;
  return result.value.result;
};

const providerIdentity = (
  version = "1",
): ProviderIdentity & { readonly version: string } => ({
  id: "copy-identity",
  name: "Copy identity provider",
  version,
});

const copyProfile = (sessionId: string, version = "1") =>
  createAnalysisProfile(providerIdentity(version), {
    existing_project: { program_name: "fixture", session_id: sessionId },
  });

const capability = (): CapabilityDescriptor => ({
  provider: providerIdentity(),
  operation: "address_name",
  available: true,
  reason: null,
  effects: {
    mutatesArtifact: false,
    launchesProcess: false,
    mayShowUi: false,
    mayAccessNetwork: false,
    mayWriteFilesystem: false,
    changesPermissions: false,
    requiresRoot: false,
  },
  limitations: [],
});

const available: ProviderAvailability = {
  status: "available",
  code: null,
  reason: null,
  diagnostics: {},
};

const supported: ProviderTargetSupport = {
  status: "supported",
  code: null,
  reason: null,
  diagnostics: {},
};

interface CopyClient extends AnalysisClient {
  kill(): void;
  readonly addressCalls: number;
}

interface CopyFixture {
  readonly session: BinarySession;
  readonly created: CopyClient[];
  resolutions(): number;
}

const openSession = (
  profileFor: (resolution: number) => ReturnType<typeof copyProfile>,
): CopyFixture => {
  const created: CopyClient[] = [];
  let resolutions = 0;
  const provider: AnalysisProviderCandidate = {
    identity: () => providerIdentity(),
    capabilities: () => [capability()],
    inspectAvailability: () => available,
    inspectTargetSupport: () => supported,
    resolveAnalysisProfile: () => {
      resolutions += 1;
      return Promise.resolve(ok({ profile: profileFor(resolutions) }));
    },
    createClient: () => {
      const copy = created.length + 1;
      let alive = true;
      let addressCalls = 0;
      const client: CopyClient = {
        execute: (operation) => {
          if (operation === "health")
            return Promise.resolve(
              ok(createAnalysisExecution(null, providerIdentity())),
            );
          addressCalls += 1;
          return alive
            ? Promise.resolve(
                ok(createAnalysisExecution(`copy-${copy}`, providerIdentity())),
              )
            : Promise.resolve(
                err(
                  new ProviderAdapterError(providerIdentity().id, operation, {
                    diagnostics: { reason: "process_killed" },
                  }),
                ),
              );
        },
        close: () => Promise.resolve(ok(null)),
        operationHealthSnapshot: (): ProviderOperationHealth => ({
          state: alive ? "idle" : "exited",
          stage: alive ? null : "connection",
          retryAction: alive ? null : "restart_provider",
          exitCode: alive ? null : 1,
          requests: [],
        }),
        kill: () => {
          alive = false;
        },
        get addressCalls() {
          return addressCalls;
        },
      };
      created.push(client);
      return client;
    },
  };
  const session = new BinarySession(
    SessionProviderRouter.selectable(
      new AnalysisProviderRegistry([provider]),
      [],
    ),
    new InvestigationRecords(),
  );
  return {
    session,
    created,
    resolutions: () => resolutions,
  };
};
