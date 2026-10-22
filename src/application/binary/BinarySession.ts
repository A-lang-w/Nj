import { randomUUID } from "node:crypto";

import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";
import {
  analysisProfilesEqual,
  type AnalysisProfileCommitment,
} from "../../domain/analysisProfile.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
} from "../../domain/analysisErrorCore.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { err, ok, type Result } from "../../domain/result.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { createEvidence } from "../../domain/evidence.js";
import type {
  AnalysisClient,
  AnalysisExecution,
  ExecutionOptions,
  AnalysisOperationPort,
  ProviderIdentity,
  ProviderStartAdmission,
  ProviderStartCleanup,
} from "../AnalysisProvider.js";
import type { AnalysisOperation } from "../AnalysisProvider.js";
import { OFFICIAL_TOOL_CONTRACTS } from "../../contracts/officialToolContracts.js";
import { ENHANCED_TOOL_CONTRACTS } from "../../contracts/enhancedToolContracts.js";
import type {
  BinarySessionPort,
  BinaryBindingGuard,
  OpenedTarget,
  SavedAnalysisSnapshot,
} from "./BinarySessionPort.js";
import {
  SessionProviderRouter,
  type SessionProviderRoute,
} from "./SessionProviderRouter.js";
import { InvestigationRecords } from "../investigation/InvestigationRecords.js";
import { BinarySessionRecords } from "./BinarySessionRecords.js";
import { binarySessionStatus } from "./BinarySessionStatus.js";
import {
  resolveSessionOpen,
  resolveSessionTarget,
  validateResolvedSessionTarget,
  type BinarySessionOpenOptions,
  type ResolvedSessionOpen,
} from "./BinarySessionOpen.js";
import {
  bindExecutionTarget,
  commitExecutionProfile,
  prepareSessionExecution,
} from "./BinarySessionExecution.js";
import { closeAnalysisClient } from "../../providers/AnalysisClientCleanup.js";
import { analysisErrorWithCleanupFailure } from "../../domain/analysisErrorCleanup.js";
import { profilelessNativeDispatchProfile } from "./ProfilelessNativeWorkflowSnapshot.js";
import {
  externalMutationRefusal,
  refusesExternalMutation,
} from "./ExternalMutationAdmission.js";
import {
  createTransitionRetirement,
  type TransitionRetirement,
} from "./TransitionRetirement.js";
import type { AnalysisSnapshot } from "../../domain/analysisSnapshot.js";
import { AnalysisSnapshotMismatchError } from "../../domain/evidenceErrors.js";
import {
  resolveAppBundleResourceRoot,
  type ResolvedAppBundleResourceRoot,
} from "../AppBundleExecutable.js";
import {
  BUNDLE_RESOURCE_OPERATIONS,
  type ActiveBundleResourceSession,
  type BundleResourceClientFactory,
} from "./BundleResourceSession.js";
const OFFICIAL_OPERATIONS: ReadonlySet<string> = new Set(
  OFFICIAL_TOOL_CONTRACTS.map(({ name }) => name),
);
const ENHANCED_OPERATIONS: ReadonlySet<string> = new Set(
  ENHANCED_TOOL_CONTRACTS.map(({ name }) => name),
);

interface SessionRun {
  readonly client: AnalysisClient;
  readonly route: SessionProviderRoute;
  readonly runId: string;
  /** Set once the client was closed, so it is never closed twice. */
  released: boolean;
}

interface SessionBinding extends SessionRun {
  readonly target: BinaryTarget;
  readonly profile: AnalysisProfileCommitment | null;
  readonly profilelessWorkflowProfile?: AnalysisProfileCommitment;
  nativeSourceAdmitted: boolean;
}

interface CleanupFailureTracker {
  readonly error: AnalysisError | undefined;
  readonly onFailure: (failure: AnalysisError) => void;
}

/**
 * The failure of a start, and the lifecycle it belongs to.
 *
 * The generation names the open the failed start belongs to. A forced close
 * advances the generation, so a cleanup that finds a newer generation
 * restores nothing into the slot that was closed.
 */
interface FailedStartFailure {
  /** The failure the failed start reports to its caller. */
  readonly failure: AnalysisError;
  /** The lifecycle generation of the open that owns the failed start. */
  readonly generation: number;
  /** Report each owned cleanup failure as soon as its owner observes it. */
  readonly onCleanupFailure?: (failure: AnalysisError) => void;
}

const trackCleanupFailures = (
  signal: AbortSignal | undefined,
  operation: string,
): CleanupFailureTracker => {
  let error: AnalysisError | undefined;
  let cleanupFailure: AnalysisError | undefined;
  let cancellation: AnalysisCancelledError | undefined;
  const observed = new Set<AnalysisError>();
  return {
    get error() {
      return error;
    },
    onFailure: (failure) => {
      if (
        observed.has(failure) ||
        (failure.cleanupPrimary !== undefined &&
          observed.has(failure.cleanupPrimary))
      )
        return;
      observed.add(failure);
      if (cleanupFailure === undefined) {
        if (isAborted(signal))
          cancellation = new AnalysisCancelledError(operation, {
            cause: signal?.reason,
          });
        cleanupFailure = failure;
      } else {
        cleanupFailure = analysisErrorWithCleanupFailure(
          cleanupFailure,
          failure,
          operation,
        );
      }
      error =
        cancellation === undefined
          ? cleanupFailure
          : analysisErrorWithCleanupFailure(
              cancellation,
              cleanupFailure,
              operation,
            );
    },
  };
};

/**
 * The transition a request waits for.
 *
 * The promise settles when the transition chain is done, the retirement
 * settles when that chain is retired, and the epoch names the chain the
 * request belongs to. A request whose chain was retired is rejected instead
 * of running against the target that took its place.
 */
interface TransitionAdmission {
  /** The chain the request waits for. */
  readonly promise: Promise<void>;
  /** The epoch the chain belongs to. */
  readonly epoch: number;
  /** Settles when the epoch is retired. */
  readonly retirement: TransitionRetirement;
}

/**
 * Owns the single active target shared by CLI and MCP adapters.
 *
 * Target transitions are serialized because switching targets tears down the
 * active provider client. A failed switch recreates the previous target instead
 * of retaining a client whose resources were already shut down.
 */
export class BinarySession
  extends BinarySessionRecords
  implements BinarySessionPort
{
  #active: SessionBinding | undefined;
  /**
   * The admission that bounds a provider start this session defers.
   *
   * A provider start runs under the shared limit of the slot that owns the
   * session, so the session keeps the admission the open carries: a client
   * this session creates later, such as the client of a restored target,
   * starts its provider under the same limit as the client it replaces.
   */
  #startAdmission: ProviderStartAdmission | undefined;
  #externalMutationCleanupFailure: AnalysisError | undefined;
  #pendingCleanup:
    | {
        readonly run: SessionRun;
        readonly retainDocument: boolean;
      }
    | undefined;
  /** The client of an open that has not settled yet. */
  #pendingStart: SessionRun | undefined;
  /** Advanced when a forced close retires the slot under an unsettled open. */
  #lifecycleGeneration = 0;
  #transition: Promise<void> = Promise.resolve();
  #transitionGeneration = 0;
  /**
   * The epoch of the transition chain that is still current.
   *
   * A forced close retires the chain that carried a start that ignored its
   * abort, because that chain can never settle. The requests that were
   * queued behind the abandoned start belong to the retired epoch: they
   * addressed a target the forced close took away, so they must not run
   * against the target that replaces it.
   */
  #transitionEpoch = 0;
  /** Settles when the current epoch is retired. */
  #epochRetirement: TransitionRetirement;
  /** The requests that have not settled in the current epoch. */
  #transitionPending = 0;
  readonly #calls = new Map<Promise<unknown>, number>();
  readonly #promptCompletionControllers = new Set<AbortController>();
  readonly #providerRouter: SessionProviderRouter;
  readonly #createRetirement: () => TransitionRetirement;
  readonly #bundleResourceFactory: BundleResourceClientFactory | undefined;
  #activeBundleResources: ActiveBundleResourceSession | undefined;
  #pendingBundleResourceCleanup: ActiveBundleResourceSession[] = [];
  readonly #runtimeUnavailability = new Map<
    string,
    { readonly reason: string }
  >();
  readonly #availabilityListeners = new Set<() => void | Promise<void>>();

  constructor(
    providerRouter: SessionProviderRouter,
    records: InvestigationRecords = new InvestigationRecords(),
    bundleResourceFactory?: BundleResourceClientFactory,
    /**
     * Create the retirement of an epoch.
     *
     * The retirement holds the requests that wait for the epoch, so the
     * factory lets a caller observe the waiters an epoch still holds.
     */
    createRetirement: () => TransitionRetirement = createTransitionRetirement,
  ) {
    super(records);
    this.#providerRouter = providerRouter;
    this.#bundleResourceFactory = bundleResourceFactory;
    this.#createRetirement = createRetirement;
    this.#epochRetirement = createRetirement();
  }

  /** Open an app resource root without requiring CFBundleExecutable. */
  openBundleResources(
    path: string,
    options: Pick<ExecutionOptions, "signal"> = {},
  ): Promise<Result<ResolvedAppBundleResourceRoot, AnalysisError>> {
    return this.#serialize("open_bundle_resources", async (admittedThrough) => {
      await this.#drainCalls(admittedThrough);
      if (isAborted(options.signal))
        return err(
          new AnalysisCancelledError("open_bundle_resources", {
            cause: options.signal?.reason,
          }),
        );
      if (this.#externalMutationCleanupFailure?.cleanupIncomplete === true)
        return err(this.#externalMutationCleanupFailure);
      if (this.#bundleResourceFactory === undefined)
        return err(
          new AnalysisCapabilityUnavailableError(
            "bundle-resources",
            "open_bundle_resources",
            "No app resource reader is configured.",
          ),
        );
      const resolved = await resolveAppBundleResourceRoot(path);
      if (!resolved.ok) return resolved;
      if (isAborted(options.signal))
        return err(
          new AnalysisCancelledError("open_bundle_resources", {
            cause: options.signal?.reason,
          }),
        );
      const pendingClosed = await this.#retryPendingCleanup();
      if (!pendingClosed.ok) return pendingClosed;
      const pendingResourcesClosed =
        await this.#retryPendingBundleResourceCleanup();
      if (!pendingResourcesClosed.ok) return pendingResourcesClosed;
      if (isAborted(options.signal))
        return err(
          new AnalysisCancelledError("open_bundle_resources", {
            cause: options.signal?.reason,
          }),
        );
      const runId = randomUUID();
      let bundleClient: Awaited<
        ReturnType<BundleResourceClientFactory["createClient"]>
      >;
      try {
        bundleClient = await this.#bundleResourceFactory.createClient(
          resolved.value,
        );
      } catch (cause: unknown) {
        return err(
          cause instanceof AnalysisError
            ? cause
            : new ProviderAdapterError(
                "bundle-resources",
                "open_bundle_resources",
                { cause },
              ),
        );
      }
      const candidate: ActiveBundleResourceSession = {
        root: resolved.value,
        client: bundleClient.client,
        capabilities: bundleClient.capabilities,
        runId,
      };
      const started = await candidate.client.execute("health", {}, options);
      if (!started.ok) {
        this.#pendingBundleResourceCleanup.push(candidate);
        const closed = await this.#retryPendingBundleResourceCleanup();
        return err(
          closed.ok
            ? started.error
            : analysisErrorWithCleanupFailure(
                started.error,
                closed.error,
                "open_bundle_resources",
              ),
        );
      }
      if (isAborted(options.signal)) {
        const cancelled = new AnalysisCancelledError("open_bundle_resources", {
          cause: options.signal?.reason,
        });
        this.#pendingBundleResourceCleanup.push(candidate);
        const closed = await this.#retryPendingBundleResourceCleanup();
        return err(
          closed.ok
            ? cancelled
            : analysisErrorWithCleanupFailure(
                cancelled,
                closed.error,
                "open_bundle_resources",
              ),
        );
      }
      const cleanupFailures = trackCleanupFailures(
        options.signal,
        "open_bundle_resources",
      );
      const closed = await this.#closeActive(
        {},
        false,
        true,
        cleanupFailures.onFailure,
      );
      if (!closed.ok) {
        this.#pendingBundleResourceCleanup.push(candidate);
        const candidateClosed = await this.#retryPendingBundleResourceCleanup(
          undefined,
          cleanupFailures.onFailure,
        );
        const primary = cleanupFailures.error ?? closed.error;
        return err(
          cleanupFailures.error ??
            (candidateClosed.ok
              ? primary
              : analysisErrorWithCleanupFailure(
                  primary,
                  candidateClosed.error,
                  "open_bundle_resources",
                )),
        );
      }
      if (isAborted(options.signal)) {
        const cancelled = new AnalysisCancelledError("open_bundle_resources", {
          cause: options.signal?.reason,
        });
        this.#pendingBundleResourceCleanup.push(candidate);
        const candidateClosed = await this.#retryPendingBundleResourceCleanup(
          undefined,
          cleanupFailures.onFailure,
        );
        return err(
          cleanupFailures.error ??
            (candidateClosed.ok
              ? cancelled
              : analysisErrorWithCleanupFailure(
                  cancelled,
                  candidateClosed.error,
                  "open_bundle_resources",
                )),
        );
      }
      this.#activeBundleResources = candidate;
      this.resetSnapshotInvalidation();
      return resolved;
    });
  }

  /**
   * Fast-path liveness gate (#1719): short-circuit only when the retained
   * client is genuinely alive. The probe reads the child's operation health
   * rather than the composite's unconditionally-ok `health`, so a dead child
   * falls through and a real client is started; an aborted caller leaves the
   * session untouched. Returns the fast-path result, or undefined to fall
   * through to the slow path.
   */
  async #tryRetainedFastPath(
    retained: SessionBinding,
    target: BinaryTarget,
    options: Pick<BinarySessionOpenOptions, "signal" | "snapshot">,
  ): Promise<Result<BinaryTarget, AnalysisError> | undefined> {
    const live = await this.#retainedClientLive(retained.client, options);
    if (isAborted(options.signal))
      return err(
        new AnalysisCancelledError("open_binary", {
          cause: options.signal?.reason,
        }),
      );
    if (!live) return undefined;
    if (options.snapshot !== undefined) {
      const imported = this.importAnalysisSnapshot(options.snapshot);
      if (!imported.ok) return imported;
    }
    return ok(target);
  }

  /** Identify the provider producing evidence for this session. */
  providerIdentity(
    operation?: AnalysisOperation,
    _targetId?: string,
  ): ProviderIdentity {
    const route = this.#currentRoute();
    let selected = route.binding?.identity ?? route.identity;
    if (operation !== undefined) {
      const exact = route.capabilities.get(operation)?.provider;
      if (exact !== undefined) selected = exact;
      else if (ENHANCED_OPERATIONS.has(operation)) {
        const providers = new Map<string, ProviderIdentity>();
        for (const descriptor of route.capabilities.values())
          if (
            descriptor.available &&
            OFFICIAL_OPERATIONS.has(descriptor.operation)
          )
            providers.set(descriptor.provider.id, descriptor.provider);
        if (providers.size === 1) {
          const provider = providers.values().next().value;
          if (provider !== undefined) selected = provider;
        }
      }
    }
    return structuredClone(selected);
  }

  /** External live state cannot be replayed by a direct or composed CLI workflow. */
  allowsSnapshotReplay(
    operation: AnalysisOperation,
    _targetId?: string,
  ): boolean {
    if (this.#activeBundleResources !== undefined) return false;
    const capabilities = this.#active?.route.capabilities;
    const descriptor = capabilities?.get(operation);
    if (descriptor !== undefined) return descriptor.cachePolicy !== "live";
    return ![...(capabilities?.values() ?? [])].some(
      ({ cachePolicy }) => cachePolicy === "live",
    );
  }

  invalidateSnapshotForExternalMutation(_targetId?: string): void {
    this.invalidateSnapshot();
  }

  /** Return the selected immutable profile, optionally scoped to an operation. */
  analysisProfile(
    operation?: AnalysisOperation,
    _targetId?: string,
  ): AnalysisProfileCommitment | undefined {
    const profile = this.#active?.profile;
    if (profile === null || profile === undefined) {
      if (operation !== "inspect_native_dispatch_metadata") return undefined;
      return this.#active?.profilelessWorkflowProfile === undefined
        ? undefined
        : structuredClone(this.#active.profilelessWorkflowProfile);
    }
    if (
      operation !== undefined &&
      this.providerIdentity(operation).id !== profile.provider.id
    )
      return undefined;
    return structuredClone(profile);
  }

  /** Observe runtime provider-health changes that affect discovery metadata. */
  onAvailabilityChanged(listener: () => void | Promise<void>): () => void {
    this.#availabilityListeners.add(listener);
    return () => this.#availabilityListeners.delete(listener);
  }

  /** Resolve a target and provider profile without creating a provider client. */
  previewTarget(
    target: BinaryTarget,
    options: BinarySessionOpenOptions = {},
  ): Promise<Result<ResolvedSessionOpen, AnalysisError>> {
    if (isAborted(options.signal))
      return Promise.resolve(
        err(
          new AnalysisCancelledError("open_binary", {
            cause: options.signal?.reason,
          }),
        ),
      );
    return resolveSessionTarget({
      router: this.#providerRouter,
      current: this.#active,
      target,
      options,
      stagedSnapshotMatches: (target, profile) =>
        this.matchesSnapshot(target, profile),
    }).then((resolved) =>
      resolved.ok && isAborted(options.signal)
        ? err(
            new AnalysisCancelledError("open_binary", {
              cause: options.signal?.reason,
            }),
          )
        : resolved,
    );
  }

  /**
   * Open or switch targets after draining calls against the current target.
   * Returns the switch failure even if best-effort restoration also fails.
   */
  open(
    path: string,
    options: BinarySessionOpenOptions = {},
  ): Promise<Result<OpenedTarget, AnalysisError>> {
    return this.#open(
      (admitted) =>
        resolveSessionOpen({
          router: this.#providerRouter,
          current: this.#active,
          path,
          options: admitted,
          stagedSnapshotMatches: (target, profile) =>
            this.matchesSnapshot(target, profile),
        }),
      options,
    ).then((opened) => (opened.ok ? ok({ target: opened.value }) : opened));
  }

  /** Open a previewed target without repeating parsing or provider profile discovery. */
  openResolvedTarget(
    resolved: Pick<ResolvedSessionOpen, "target" | "route">,
    options: Pick<
      BinarySessionOpenOptions,
      | "signal"
      | "snapshot"
      | "loadSnapshot"
      | "startProvider"
      | "startAdmission"
    > = {},
  ): Promise<Result<OpenedTarget, AnalysisError>> {
    return this.#open(
      () =>
        Promise.resolve(
          validateResolvedSessionTarget({
            ...resolved,
            current: this.#active,
            options,
            stagedSnapshotMatches: (target, profile) =>
              this.matchesSnapshot(target, profile),
          }),
        ),
      options,
    ).then((opened) => (opened.ok ? ok({ target: opened.value }) : opened));
  }

  #open(
    resolve: (
      admitted: BinarySessionOpenOptions,
    ) => Promise<Result<ResolvedSessionOpen, AnalysisError>>,
    options: BinarySessionOpenOptions,
  ): Promise<Result<BinaryTarget, AnalysisError>> {
    return this.#serialize("open_binary", async (admittedThrough) => {
      const admitted = await this.#withLoadedSnapshot(options);
      if (!admitted.ok) return admitted;
      return this.#openWithinTransition(
        admittedThrough,
        () => resolve(admitted.value),
        admitted.value,
      );
    });
  }

  /** Read the staged snapshot only after earlier lifecycle transitions have settled. */
  async #withLoadedSnapshot(
    options: BinarySessionOpenOptions,
  ): Promise<Result<BinarySessionOpenOptions, AnalysisError>> {
    if (options.loadSnapshot === undefined) return ok(options);
    if (isAborted(options.signal))
      return err(
        new AnalysisCancelledError("open_binary", {
          cause: options.signal?.reason,
        }),
      );
    const loaded = await options.loadSnapshot(options.signal);
    if (!loaded.ok) return loaded;
    const { loadSnapshot: _loaded, ...rest } = options;
    return ok({ ...rest, snapshot: loaded.value });
  }

  async #openWithinTransition(
    admittedThrough: number,
    resolve: () => Promise<Result<ResolvedSessionOpen, AnalysisError>>,
    options: Pick<
      BinarySessionOpenOptions,
      "signal" | "snapshot" | "startProvider" | "startAdmission"
    >,
  ): Promise<Result<BinaryTarget, AnalysisError>> {
    const generation = this.#lifecycleGeneration;
    // The provider starts of this session run under the admission the open
    // carries. The session keeps it, so a client the session creates later,
    // such as the client of a restored target, starts its provider under the
    // same limit as the client it replaces.
    this.#startAdmission = options.startAdmission;
    if (this.#externalMutationCleanupFailure?.cleanupIncomplete === true)
      return err(this.#externalMutationCleanupFailure);
    if (isAborted(options.signal))
      return err(
        new AnalysisCancelledError("open_binary", {
          cause: options.signal?.reason,
        }),
      );
    const resolved = await resolve();
    if (!resolved.ok) return resolved;
    const { target, route, sameTarget } = resolved.value;
    const { profile } = route;
    if (isAborted(options.signal))
      return err(
        new AnalysisCancelledError("open_binary", {
          cause: options.signal?.reason,
        }),
      );
    const activeProfile = this.#active?.profile;
    const sameProfile =
      activeProfile === null || activeProfile === undefined
        ? profile === null
        : profile !== null && analysisProfilesEqual(activeProfile, profile);
    await this.#drainCalls(admittedThrough);
    if (isAborted(options.signal))
      return err(
        new AnalysisCancelledError("open_binary", {
          cause: options.signal?.reason,
        }),
      );
    const pendingClosed = await this.#retryPendingCleanup();
    if (!pendingClosed.ok) return pendingClosed;
    const pendingResourcesClosed =
      await this.#retryPendingBundleResourceCleanup();
    if (!pendingResourcesClosed.ok) return pendingResourcesClosed;
    if (isAborted(options.signal))
      return err(
        new AnalysisCancelledError("open_binary", {
          cause: options.signal?.reason,
        }),
      );
    const retained = sameTarget && sameProfile ? this.#active : undefined;
    if (retained !== undefined) {
      const fastPath = await this.#tryRetainedFastPath(
        retained,
        target,
        options,
      );
      if (fastPath !== undefined) return fastPath;
    }
    const previous = this.#active;
    this.#active = undefined;
    if (previous !== undefined) {
      const closed = await this.#retireClient(previous);
      if (!closed.ok) {
        // A failed open retires the provider cache, not the investigation.
        // Preserve Evidence and Unknown history for export and recovery.
        this.clearSnapshot();
        this.#clearRuntimeAvailability();
        if (isAborted(options.signal))
          return err(
            analysisErrorWithCleanupFailure(
              new AnalysisCancelledError("open_binary", {
                cause: options.signal?.reason,
              }),
              closed.error,
              "open_binary",
            ).bindCleanupDependencies([closed.error]),
          );
        return closed;
      }
    }
    if (isAborted(options.signal))
      return err(
        await this.#restoreAfterFailedOpen(
          previous,
          new AnalysisCancelledError("open_binary", {
            cause: options.signal?.reason,
          }),
          generation,
        ),
      );
    const runId = randomUUID();
    const client = route.createClient(target, {
      runId,
      // The client starts a provider it defers under this admission, so the
      // shared start limit covers that start.
      ...(options.startAdmission === undefined
        ? {}
        : { startAdmission: options.startAdmission }),
    });
    const run: SessionRun = { client, route, runId, released: false };
    this.#pendingStart = run;
    // The cleanup of a failed start owns the client it started and the target
    // it replaced. It runs once: the admission runs it under the start limit,
    // and the failure the admission reports keeps that answer.
    let failedStart: ProviderStartCleanup | undefined;
    const cleanup = async (
      failure: AnalysisError,
    ): Promise<ProviderStartCleanup> => {
      if (failedStart !== undefined) return failedStart;
      failedStart = await this.#failedStart(run, previous, {
        failure,
        generation,
      });
      return failedStart;
    };
    // A provider start that rejects instead of returning an error must still
    // release its client. The rejection would otherwise skip the failure path
    // that owns the cleanup and leave the provider process running.
    const started = await this.#startClient(run, options, cleanup).catch(
      (cause: unknown) =>
        err(
          new ProviderAdapterError(route.identity.id, "health", {
            cause,
            diagnostics: {
              reason:
                "the provider start rejected instead of returning an error",
            },
          }),
        ),
    );
    if (this.#pendingStart === run) this.#pendingStart = undefined;
    if (generation !== this.#lifecycleGeneration) {
      // A forced close retired this slot while the start was in flight. The
      // client is already released, and the open must not restore a target
      // into a slot the caller closed.
      await this.#releaseRun(run);
      return err(new AnalysisCancelledError("open_binary"));
    }
    if (!started.ok) {
      // The failed start already ran its cleanup: the client it started was
      // released, or the cleanup kept it for a later retry. A failure the
      // admission reported without running that cleanup runs it here, so the
      // client the open created is released and the target it replaced is
      // restored either way.
      const failed = await cleanup(started.error);
      return err(failed.error);
    }
    if (isAborted(options.signal)) {
      return err(
        await this.#failedOpen(run, previous, {
          failure: new AnalysisCancelledError("open_binary", {
            cause: options.signal?.reason,
          }),
          generation,
        }),
      );
    }
    const cleanupFailures = trackCleanupFailures(options.signal, "open_binary");
    if (this.#activeBundleResources !== undefined) {
      this.#pendingBundleResourceCleanup.push(this.#activeBundleResources);
      this.#activeBundleResources = undefined;
      const retiredResources = await this.#retryPendingBundleResourceCleanup(
        undefined,
        cleanupFailures.onFailure,
      );
      if (!retiredResources.ok) {
        const primary = cleanupFailures.error ?? retiredResources.error;
        const failed = await this.#failedOpen(run, previous, {
          failure: primary,
          generation,
          onCleanupFailure: cleanupFailures.onFailure,
        });
        return err(cleanupFailures.error ?? failed);
      }
    }
    if (isAborted(options.signal)) {
      const cancelled = new AnalysisCancelledError("open_binary", {
        cause: options.signal?.reason,
      });
      const failed = await this.#failedOpen(run, previous, {
        failure: cancelled,
        generation,
        onCleanupFailure: cleanupFailures.onFailure,
      });
      return err(cleanupFailures.error ?? failed);
    }
    const profilelessWorkflowProfile =
      profile === null ? profilelessNativeDispatchProfile(route) : undefined;
    this.#active = {
      target,
      profile,
      ...(profilelessWorkflowProfile === undefined
        ? {}
        : { profilelessWorkflowProfile }),
      ...run,
      nativeSourceAdmitted: false,
    };
    this.#clearRuntimeAvailability();
    this.resetSnapshotInvalidation();
    if (options.snapshot === undefined) {
      if (profile === null) this.clearSnapshot();
      else this.selectSnapshot(target, profile);
    }
    if (options.snapshot !== undefined) {
      const imported = this.importAnalysisSnapshot(options.snapshot);
      if (!imported.ok) {
        this.#active = undefined;
        return err(
          await this.#failedOpen(run, previous, {
            failure: imported.error,
            generation,
          }),
        );
      }
    }
    return ok(target);
  }

  /**
   * Start the provider this open binds.
   *
   * The health probe is the start for a client that starts its provider with
   * its first call. A composed client answers that probe without touching a
   * child, so an open that reports the target as started asks the client to
   * start the provider it selected. The start belongs to this window, so a
   * close that gives up on it still owns the client it started.
   *
   * A start that runs under the shared admission is bounded by the analysis
   * cap. The admission takes the limit around the start itself, after the
   * calls that ran before it have drained: an open that held the limit while
   * it waited for those calls would wait for a request that waits for that
   * same limit.
   *
   * A failed start leaves a provider behind, and the cleanup of that failed
   * start runs under the same limit: the limit counts the provider while it
   * may still be running. Every failure of the start sequence runs that
   * cleanup, so the client the open created is released under the limit that
   * counted its provider.
   */
  async #startClient(
    run: SessionRun,
    options: Pick<
      BinarySessionOpenOptions,
      "signal" | "startProvider" | "startAdmission"
    >,
    cleanup: (failure: AnalysisError) => Promise<ProviderStartCleanup>,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const providerStart = run.client.startProvider;
    if (providerStart === undefined) {
      // The client starts its provider with its first call, so the health
      // probe is that start.
      const probe = (): Promise<Result<AnalysisExecution, AnalysisError>> =>
        run.client.execute("health", {}, options);
      return this.#runAdmittedStart(probe, run, options, cleanup);
    }
    // The client starts the provider it selected, so the probe and that start
    // belong to one window: a probe that fails runs the cleanup of the failed
    // open under the limit that counts the provider the probe left behind.
    const start = async (): Promise<
      Result<AnalysisExecution, AnalysisError>
    > => {
      const health = await run.client.execute("health", {}, options);
      if (!health.ok) return health;
      if (options.startProvider !== true) return health;
      const started = await providerStart(options);
      return started.ok ? health : err(started.error);
    };
    return this.#runAdmittedStart(start, run, options, cleanup);
  }

  /**
   * Run one provider start under the shared start limit.
   *
   * A start that rejects instead of returning an error is reported as a
   * failure, so the cleanup of the failed start still runs and the client the
   * start owned is released.
   *
   * The cleanup of a failed start runs under the same limit, so the limit
   * counts the provider the failed start left behind until the cleanup
   * settles. Without an admission the cleanup runs here, so a session that
   * owns no limit still releases the client of a failed start.
   */
  async #runAdmittedStart<Value>(
    start: () => Promise<Result<Value, AnalysisError>>,
    run: SessionRun,
    options: Pick<BinarySessionOpenOptions, "signal" | "startAdmission">,
    cleanup: (failure: AnalysisError) => Promise<ProviderStartCleanup>,
  ): Promise<Result<Value, AnalysisError>> {
    const guarded = async (): Promise<Result<Value, AnalysisError>> => {
      try {
        return await start();
      } catch (cause: unknown) {
        return err(
          new ProviderAdapterError(run.route.identity.id, "health", {
            cause,
            diagnostics: {
              reason:
                "the provider start rejected instead of returning an error",
            },
          }),
        );
      }
    };
    const admission = options.startAdmission;
    if (admission !== undefined)
      return admission.run(guarded, "open_binary", options.signal, cleanup);
    const started = await guarded();
    if (started.ok) return started;
    const failed = await cleanup(started.error);
    return err(failed.error);
  }

  /** Serialize an external mutation and retire the potentially stale analysis. */
  withAdmittedExternalMutation<Value>(
    _path: string | undefined,
    signal: AbortSignal | undefined,
    operation: () => Promise<Result<Value, AnalysisError>>,
    retirementFailure: (
      value: Result<Value, AnalysisError>,
      error: AnalysisError,
    ) => AnalysisError,
    operationName = "execute_rizin_command",
    cleanupRecovery?: (
      failure: AnalysisError | undefined,
    ) => Promise<Result<null, AnalysisError>>,
  ): Promise<Result<Result<Value, AnalysisError>, AnalysisError>> {
    return this.#serialize(operationName, async (admittedThrough) => {
      if (this.#activeBundleResources !== undefined)
        return err(
          new AnalysisCapabilityUnavailableError(
            "bundle-resources",
            operationName,
            "External mutation requires an active executable analysis target.",
          ),
        );
      if (isAborted(signal))
        return err(new AnalysisCancelledError(operationName));
      await this.#drainCalls(admittedThrough);
      if (isAborted(signal))
        return err(new AnalysisCancelledError(operationName));

      if (this.#externalMutationCleanupFailure?.cleanupIncomplete === true) {
        if (cleanupRecovery === undefined)
          return err(this.#externalMutationCleanupFailure);
        const recovered = await cleanupRecovery(
          this.#externalMutationCleanupFailure,
        );
        if (!recovered.ok) return recovered;
        if (this.#externalMutationCleanupFailure.cleanupIncomplete)
          return err(this.#externalMutationCleanupFailure);
        this.#externalMutationCleanupFailure = undefined;
      }

      const pendingCleanup = await this.#retryPendingCleanup();
      if (!pendingCleanup.ok) return pendingCleanup;

      const activeAtDispatch = this.#active;
      if (
        activeAtDispatch !== undefined &&
        refusesExternalMutation(
          activeAtDispatch.route.binding?.identity.id ?? "",
        )
      )
        return err(externalMutationRefusal(operationName));
      // A protocol reply does not prove that background writers have stopped.
      // Retire the old analysis and require an explicit fresh open rather than
      // silently binding a snapshot while an unrestricted command can still write.
      const retireTarget = activeAtDispatch !== undefined;
      this.invalidateSnapshot();
      const value = await operation();
      this.#externalMutationCleanupFailure =
        !value.ok && value.error.cleanupIncomplete ? value.error : undefined;
      if (!retireTarget) return ok(value);

      const retired = await this.#closeActive({}, false);
      if (!retired.ok) return err(retirementFailure(value, retired.error));
      return ok(value);
    });
  }

  /** Close the active target, if any. */
  close(
    options: Pick<ExecutionOptions, "progress"> & {
      readonly retainProviderDocuments?: boolean;
      readonly targetId?: string;
    } = {},
  ): Promise<Result<null, AnalysisError>> {
    return this.closeAsSlot(options, {
      clearRecords: true,
      closeOwnedProviderResources: true,
    });
  }

  /** Close this slot on behalf of the multi-target registry. */
  closeAsSlot(
    options: Pick<ExecutionOptions, "progress"> & {
      readonly retainProviderDocuments?: boolean;
      readonly targetId?: string;
    },
    behavior: {
      readonly clearRecords: boolean;
      readonly closeOwnedProviderResources: boolean;
    },
  ): Promise<Result<null, AnalysisError>> {
    return this.#serialize("close_binary", async (admittedThrough) => {
      await this.#drainCalls(admittedThrough);
      return this.#closeActive(
        options,
        behavior.clearRecords,
        behavior.closeOwnedProviderResources,
      );
    });
  }

  /**
   * Release a start that ignored its abort.
   *
   * A provider start that never unwinds must not hold the slot's cleanup: the
   * ordinary close serializes behind the open that holds the transition, so a
   * wedged start would wedge every later close, every later open and the server
   * shutdown. This path does not wait for that transition. It releases the
   * pending client through the same client close that owns provider cleanup,
   * invalidates the unsettled open so it cannot restore a target into the
   * closed slot, releases the slot's records and owned resources as the caller
   * asked, and releases the transition chain so the slot stays usable.
   */
  async closeWithoutTransition(
    options: Pick<ExecutionOptions, "progress"> & {
      readonly retainProviderDocuments?: boolean;
      readonly targetId?: string;
    },
    behavior: {
      readonly clearRecords: boolean;
      readonly closeOwnedProviderResources: boolean;
    },
  ): Promise<Result<null, AnalysisError>> {
    this.#lifecycleGeneration += 1;
    const pending = this.#pendingStart;
    this.#pendingStart = undefined;
    const released =
      pending === undefined ? ok(null) : await this.#releaseRun(pending);
    // The wedged open still holds the transition chain. Releasing the pending
    // client does not settle it, and every later close, open and the server
    // shutdown serialize behind it. The chain is retired so the slot stays
    // usable; the unsettled open is invalidated by the lifecycle generation
    // above, so it cannot restore a target into the closed slot when it
    // eventually unwinds, and the requests that were queued behind it are
    // retired with the chain, so they cannot reach the target that replaces
    // the closed one.
    this.#retireTransition();
    if (!released.ok) return released;
    return this.#closeActive(
      options,
      behavior.clearRecords,
      behavior.closeOwnedProviderResources,
    );
  }

  /** Drain earlier requests, save an immutable snapshot, and close under one lifecycle lock. */
  closeWithSnapshot(
    path: string,
    overwrite: boolean,
    options: Pick<ExecutionOptions, "progress"> & {
      readonly targetId?: string;
    } = {},
  ): Promise<Result<SavedAnalysisSnapshot, AnalysisError>> {
    return this.closeWithSnapshotAsSlot(path, overwrite, options, {
      clearRecords: true,
      closeOwnedProviderResources: true,
    });
  }

  /** Save a snapshot and close this slot on behalf of the multi-target registry. */
  closeWithSnapshotAsSlot(
    path: string,
    overwrite: boolean,
    options: Pick<ExecutionOptions, "progress"> & {
      readonly targetId?: string;
    },
    behavior: {
      readonly clearRecords: boolean;
      readonly closeOwnedProviderResources: boolean;
    },
  ): Promise<Result<SavedAnalysisSnapshot, AnalysisError>> {
    return this.#serialize("close_binary", async (admittedThrough) => {
      await this.#drainCalls(admittedThrough);
      const snapshot = this.exportAnalysisSnapshot();
      if (!snapshot.ok) return snapshot;
      const written = await this.writeAnalysisSnapshot(
        snapshot.value,
        path,
        overwrite,
      );
      if (!written.ok) return written;
      const closed = await this.#closeActive(
        options,
        behavior.clearRecords,
        behavior.closeOwnedProviderResources,
      );
      return closed.ok
        ? ok({
            ...written.value,
            primitive_entries: snapshot.value.entries.length,
            workflow_entries: snapshot.value.workflow_entries.length,
            evidence_records: snapshot.value.evidence_bundle.records.length,
          })
        : closed;
    });
  }

  async #closeActive(
    options: Pick<ExecutionOptions, "progress"> & {
      readonly retainProviderDocuments?: boolean;
    },
    clearRecords = true,
    closeOwnedProviderResources = true,
    onCleanupFailure?: (failure: AnalysisError) => void,
  ): Promise<Result<null, AnalysisError>> {
    const previous = this.#active;
    const previousResources = this.#activeBundleResources;
    this.#active = undefined;
    this.#activeBundleResources = undefined;
    if (previousResources !== undefined)
      this.#pendingBundleResourceCleanup.push(previousResources);
    const closed =
      previous === undefined
        ? await this.#retryPendingCleanup(
            options.progress,
            options.retainProviderDocuments,
            onCleanupFailure,
          )
        : await this.#retireClient(previous, {
            ...(options.progress === undefined
              ? {}
              : { progress: options.progress }),
            ...(options.retainProviderDocuments === true
              ? { retainDocument: true }
              : {}),
            ...(onCleanupFailure === undefined ? {} : { onCleanupFailure }),
          });
    if (clearRecords) this.clearSessionRecords();
    this.#clearRuntimeAvailability();
    const fileResources = await this.closeWriteResources();
    if (!fileResources.ok) onCleanupFailure?.(fileResources.error);
    const candidateResources = closeOwnedProviderResources
      ? await this.#providerRouter.closeOwnedResources()
      : ok(null);
    if (!candidateResources.ok) onCleanupFailure?.(candidateResources.error);
    const bundleClosed = await this.#retryPendingBundleResourceCleanup(
      options.progress,
      onCleanupFailure,
    );
    const resourceFailures = [
      ...(bundleClosed.ok ? [] : [bundleClosed.error]),
      ...(fileResources.ok ? [] : [fileResources.error]),
      ...(candidateResources.ok ? [] : [candidateResources.error]),
    ];
    let resourceFailure = resourceFailures[0];
    for (const next of resourceFailures.slice(1))
      if (resourceFailure !== undefined)
        resourceFailure = analysisErrorWithCleanupFailure(
          resourceFailure,
          next,
          "close_binary",
        );
    if (!closed.ok && resourceFailure !== undefined)
      return err(
        analysisErrorWithCleanupFailure(
          closed.error,
          resourceFailure,
          "close_binary",
        ),
      );
    if (!closed.ok) return closed;
    return resourceFailure === undefined ? ok(null) : err(resourceFailure);
  }

  async #retryPendingBundleResourceCleanup(
    progress?: ExecutionOptions["progress"],
    onCleanupFailure?: (failure: AnalysisError) => void,
  ): Promise<Result<null, AnalysisError>> {
    if (this.#pendingBundleResourceCleanup.length === 0) return ok(null);
    const pending = this.#pendingBundleResourceCleanup;
    const retained: ActiveBundleResourceSession[] = [];
    let failure: AnalysisError | undefined;
    for (const session of pending) {
      const closed = await closeAnalysisClient(
        session.client,
        "bundle-resources",
        {
          ...(progress === undefined ? {} : { progress }),
          ...(onCleanupFailure === undefined ? {} : { onCleanupFailure }),
        },
      );
      if (!closed.ok) {
        retained.push(session);
        failure =
          failure === undefined
            ? closed.error
            : analysisErrorWithCleanupFailure(
                failure,
                closed.error,
                "close_binary",
              );
      }
    }
    this.#pendingBundleResourceCleanup = retained;
    return failure === undefined ? ok(null) : err(failure);
  }

  async #retireClient(
    run: SessionRun,
    options: Pick<ExecutionOptions, "progress"> & {
      readonly retainDocument?: boolean;
      readonly onCleanupFailure?: (failure: AnalysisError) => void;
    } = {},
  ): Promise<Result<null, AnalysisError>> {
    // A forced close already released this client; it owns no cleanup.
    if (run.released) return ok(null);
    this.#pendingCleanup = {
      run,
      retainDocument: options.retainDocument === true,
    };
    return this.#retryPendingCleanup(
      options.progress,
      undefined,
      options.onCleanupFailure,
    );
  }

  /** Release one provider client once, through the owner of provider cleanup. */
  async #releaseRun(run: SessionRun): Promise<Result<null, AnalysisError>> {
    if (run.released) return ok(null);
    // A run whose cleanup is already pending owns its own close, and a failed
    // cleanup keeps that ownership for a retry. Releasing it here would close
    // the client a second time.
    if (this.#pendingCleanup?.run === run) return this.#retryPendingCleanup();
    // Another run may own the pending cleanup. It is retried first, so its
    // ownership is not lost, and this run waits behind it.
    const pending = await this.#retryPendingCleanup();
    if (!pending.ok) return pending;
    // A failed close keeps this run's cleanup pending, so a later release
    // retries it. The run is marked released only once the close succeeded;
    // marking it before would let a client that is still alive escape every
    // retry.
    this.#pendingCleanup = { run, retainDocument: false };
    const closed = await this.#retryPendingCleanup();
    return closed;
  }

  async #retryPendingCleanup(
    progress?: ExecutionOptions["progress"],
    retainDocument?: boolean,
    onCleanupFailure?: (failure: AnalysisError) => void,
  ): Promise<Result<null, AnalysisError>> {
    let pending = this.#pendingCleanup;
    if (pending === undefined) return ok(null);
    if (retainDocument !== undefined) {
      pending = { ...pending, retainDocument };
      this.#pendingCleanup = pending;
    }
    const closed = await closeAnalysisClient(
      pending.run.client,
      pending.run.route.identity.id,
      {
        ...(progress === undefined ? {} : { progress }),
        ...(pending.retainDocument ? { retainDocument: true } : {}),
        ...(onCleanupFailure === undefined ? {} : { onCleanupFailure }),
      },
    );
    if (closed.ok) {
      // The client is closed, so the run owns no cleanup any more and it is
      // never closed a second time.
      this.#pendingCleanup = undefined;
      pending.run.released = true;
    }
    return closed;
  }

  /**
   * Release the provider a close could not release.
   *
   * A close that could not stop the provider keeps the cleanup pending, so
   * the provider that may still be running stays owned by this session. A
   * caller that waits for that provider retries the cleanup here: the open
   * that would retry it waits for the permit the cleanup owns, so the retry
   * has to happen before that wait.
   *
   * The retry answers whether the provider is gone. A slot without a pending
   * cleanup owns no provider, so it answers that the provider is gone.
   */
  releasePendingProvider(): Promise<Result<null, AnalysisError>> {
    return this.#retryPendingCleanup();
  }

  /**
   * Release the client of a failed open and report the failure it answers
   * with.
   */
  async #failedOpen(
    run: SessionRun,
    previous: SessionBinding | undefined,
    failed: FailedStartFailure,
  ): Promise<AnalysisError> {
    const cleanup = await this.#failedStart(run, previous, failed);
    return cleanup.error;
  }

  /**
   * The cleanup of a failed start.
   *
   * The failed start left a provider behind, and this cleanup owns it: it
   * either released the provider or kept it for a later retry. The cleanup
   * reports the failure the open answers with, and whether the provider may
   * still be running, so the caller can keep counting that provider against
   * the analysis limit.
   *
   * The cleanup restores the target the open replaced, and only while this
   * slot still owns it: a forced close retired the slot while the start was
   * in flight, and a target restored into a closed slot would take the slot
   * back from the target that replaced it.
   *
   * A cleanup that rejects instead of answering is reported as a failure
   * that left the provider behind: the client stays owned by this session,
   * so a later close retries the cleanup.
   */
  async #failedStart(
    run: SessionRun,
    previous: SessionBinding | undefined,
    failed: FailedStartFailure,
  ): Promise<ProviderStartCleanup> {
    const { failure, generation, onCleanupFailure } = failed;
    try {
      const closed = await this.#retireClient(
        run,
        onCleanupFailure === undefined ? {} : { onCleanupFailure },
      );
      if (!closed.ok)
        return {
          error: analysisErrorWithCleanupFailure(
            failure,
            closed.error,
            "open_binary",
          ),
          // The provider could not be released, so it may still be running.
          providerAlive: true,
        };
      return {
        error: await this.#restoreAfterFailedOpen(
          previous,
          failure,
          generation,
        ),
        providerAlive: false,
      };
    } catch (cause: unknown) {
      return {
        error: new ProviderAdapterError(run.route.identity.id, "health", {
          cause,
          diagnostics: {
            reason:
              "the cleanup of the failed start rejected instead of returning an error",
          },
        }),
        // The provider was not proven released, so it may still be running.
        providerAlive: true,
      };
    }
  }

  async #restoreAfterFailedOpen(
    previous: SessionBinding | undefined,
    primary: AnalysisError,
    generation: number,
  ): Promise<AnalysisError> {
    const restored = await this.#restore(previous, generation);
    return restored.ok
      ? primary
      : analysisErrorWithCleanupFailure(primary, restored.error, "open_binary");
  }

  /** Describe the active binary session. */
  status(
    options: {
      readonly signal?: AbortSignal;
      readonly targetId?: string;
    } = {},
  ): Promise<JsonValue> {
    const resourceRun = this.#activeBundleResources;
    const run =
      this.#active ??
      resourceRun ??
      this.#pendingBundleResourceCleanup[0] ??
      this.#pendingCleanup?.run;
    const client = run?.client;
    return binarySessionStatus({
      ...options,
      target: this.#active?.target,
      ...(resourceRun === undefined
        ? {}
        : {
            bundleResourceRoot: resourceRun.root,
            resourceCapabilities: resourceRun.capabilities,
          }),
      route: this.#currentRoute(),
      router: this.#providerRouter,
      runtimeUnavailability: this.#runtimeUnavailability,
      runId: run?.runId,
      runtimeLineageSnapshots: client?.runtimeLineageSnapshots?.() ?? [],
      requestActivitySnapshots: client?.requestActivitySnapshots?.() ?? [],
      providerOperationHealth: client?.operationHealthSnapshot?.() ?? null,
      cleanupPending:
        this.#pendingCleanup !== undefined ||
        this.#pendingBundleResourceCleanup.length > 0 ||
        this.hasPendingFileResources ||
        this.#providerRouter.hasPendingOwnedResources(),
    });
  }

  /** Return the immutable artifact identity captured before its provider started. */
  activeTarget(_targetId?: string): BinaryTarget | undefined {
    return this.#active === undefined
      ? undefined
      : structuredClone(this.#active.target);
  }

  activeBundleResourceRoot(): ResolvedAppBundleResourceRoot | undefined {
    const root = this.#activeBundleResources?.root;
    return root === undefined ? undefined : structuredClone(root);
  }

  override exportAnalysisSnapshot() {
    if (this.#activeBundleResources !== undefined)
      return err(
        new AnalysisSnapshotMismatchError(
          "Analysis snapshots do not apply to a resource-only app session because it has no executable identity or replay binding.",
        ),
      );
    return super.exportAnalysisSnapshot();
  }

  override importAnalysisSnapshot(snapshot: AnalysisSnapshot) {
    if (this.#activeBundleResources !== undefined)
      return err(
        new AnalysisSnapshotMismatchError(
          "Analysis snapshots do not apply to a resource-only app session because it has no executable identity or replay binding.",
        ),
      );
    return super.importAnalysisSnapshot(snapshot);
  }

  protected activeAnalysisBinding() {
    return this.#active;
  }

  /**
   * Invoke a provider operation against the active target.
   * Calls may overlap, but a pending target transition prevents new calls from
   * entering until the transition has settled.
   */
  execute(
    name: Parameters<AnalysisOperationPort["execute"]>[0],
    arguments_: Readonly<Record<string, JsonValue>>,
    options?: Pick<ExecutionOptions, "signal" | "selectorOrigin"> & {
      readonly bindingGuard?: BinaryBindingGuard;
    },
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const generation = this.#transitionGeneration;
    const admission = this.#admission();
    const call = this.#execute(name, arguments_, options, admission);
    this.#calls.set(call, generation);
    return call.finally(() => this.#calls.delete(call));
  }

  /** Run a prompt lookup only against an already connected provider child. */
  executeIfProviderReady(
    name: Parameters<AnalysisOperationPort["execute"]>[0],
    arguments_: Readonly<Record<string, JsonValue>>,
    options?: Pick<ExecutionOptions, "signal" | "selectorOrigin" | "targetId">,
  ): Promise<Result<AnalysisExecution, AnalysisError> | undefined> {
    const active = this.#active;
    if (
      this.#transitionPending > 0 ||
      active === undefined ||
      active.client.executeIfReady === undefined
    )
      return Promise.resolve(undefined);

    const controller = new AbortController();
    this.#promptCompletionControllers.add(controller);
    const signal =
      options?.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, options.signal]);
    const generation = this.#transitionGeneration;
    const call = active.client.executeIfReady(name, arguments_, {
      ...options,
      signal,
    });
    this.#calls.set(call, generation);
    return call.finally(() => {
      this.#calls.delete(call);
      this.#promptCompletionControllers.delete(controller);
    });
  }

  /** Admit one composed request until its result and session bookkeeping settle. */
  withAdmittedAnalysis<Value>(
    operationName: string,
    signal: AbortSignal | undefined,
    operation: (analysis: AnalysisOperationPort) => Promise<Value>,
    _targetId?: string,
    _waitMs?: number,
    bindingGuard?: BinaryBindingGuard,
  ): Promise<Result<Value, AnalysisError>> {
    const generation = this.#transitionGeneration;
    const transition = this.#admission();
    const call = (async (): Promise<Result<Value, AnalysisError>> => {
      const admission = await this.#waitForTransition(
        operationName,
        signal,
        transition,
      );
      if (!admission.ok) return admission;
      // The check runs under the admission that protects the execution, so a
      // request that waited behind a replacement never runs against the
      // target that took the place of the one it addressed.
      const guarded = bindingGuard?.();
      if (guarded !== undefined && !guarded.ok) return guarded;
      return ok(
        await operation({
          execute: (name, arguments_, options) =>
            this.#execute(name, arguments_, options, {
              // The admitted operation runs inside the transition it waited
              // for, so its own calls do not wait for the chain again.
              promise: Promise.resolve(),
              epoch: transition.epoch,
              retirement: transition.retirement,
            }),
        }),
      );
    })();
    // Register synchronously before a lifecycle transition can snapshot calls.
    this.#calls.set(call, generation);
    return call.finally(() => this.#calls.delete(call));
  }

  async #execute(
    name: Parameters<AnalysisOperationPort["execute"]>[0],
    arguments_: Readonly<Record<string, JsonValue>>,
    options:
      | (Pick<ExecutionOptions, "signal" | "selectorOrigin"> & {
          readonly bindingGuard?: BinaryBindingGuard;
        })
      | undefined,
    admission: TransitionAdmission,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const transitioned = await this.#waitForTransition(
      name,
      options?.signal,
      admission,
    );
    if (!transitioned.ok) return transitioned;
    // The check runs under the admission that protects the execution, so a
    // request that waited behind a replacement never runs against the
    // target that took the place of the one it addressed.
    const guarded = options?.bindingGuard?.();
    if (guarded !== undefined && !guarded.ok) return guarded;
    const resources = this.#activeBundleResources;
    if (resources !== undefined) {
      if (!BUNDLE_RESOURCE_OPERATIONS.has(name))
        return err(
          new AnalysisCapabilityUnavailableError(
            "bundle-resources",
            name,
            "This operation requires an executable analysis target; the active session contains only app resource access.",
          ),
        );
      const result = await resources.client.execute(name, arguments_, options);
      if (!result.ok) return result;
      const execution = { ...result.value, subject: null };
      return ok(execution);
    }
    const prepared = prepareSessionExecution({
      active: this.#active,
      operation: name,
      parameters: arguments_,
      nativeSourceAdmitted: this.#active?.nativeSourceAdmitted === true,
      unboundOperationError: (operation, route) =>
        this.#providerRouter.unboundOperationError(operation, route),
      lookupSnapshot: (target, profile, operation, parameters) =>
        operation === "decode_interface_builder" ||
        operation === "inspect_asset_catalog" ||
        operation === "inspect_keyed_archive" ||
        operation === "trace_dylib_resolution"
          ? undefined
          : this.lookupSnapshot(target, profile, operation, parameters),
    });
    if (!prepared.ok) return prepared;
    const { active, capability, profile, cacheable, cached } = prepared.value;
    if (cached !== undefined) return ok(cached);
    // A failed reply cannot prove that a dispatched metadata write rolled back.
    // Stop replay before dispatch, including reads overlapping the write.
    if (capability.effects.mutatesArtifact) this.invalidateSnapshot();
    // The binding check belongs to this session, not to the provider.
    const { bindingGuard: _bindingGuard, ...providerOptions } = options ?? {};
    const call = active.client.execute(name, arguments_, providerOptions);
    const result = await call;
    const profiled = bindExecutionTarget(
      commitExecutionProfile(name, result, profile),
      name,
      active.target,
    );
    const execution =
      profiled.ok &&
      (name === "procedure_callers" || name === "procedure_callees") &&
      profiled.value.relationshipCoverage === undefined
        ? ok({
            ...profiled.value,
            relationshipCoverage: {
              status: "unknown" as const,
              reason:
                "Provider did not report relationship coverage for this observation.",
            },
          })
        : profiled;
    // A successful Ghidra operation proves this client's native source snapshot
    // was admitted; a composite health response and parsed path do not.
    if (
      execution.ok &&
      capability.provider.id === "ghidra" &&
      this.#active === active
    )
      this.#active.nativeSourceAdmitted = true;
    this.#observeRuntimeAvailability(name, execution);
    if (
      execution.ok &&
      cacheable &&
      profile !== undefined &&
      name !== "decode_interface_builder" &&
      name !== "inspect_asset_catalog" &&
      name !== "inspect_keyed_archive" &&
      name !== "trace_dylib_resolution"
    ) {
      const evidence = createEvidence(
        execution.value.subject === undefined
          ? active.target
          : (execution.value.subject ?? undefined),
        execution.value.provider,
        {
          operation: name,
          parameters: arguments_,
          result: execution.value.result,
          analysisProfile: profile,
          rawResult: execution.value.rawResult,
          limitations: execution.value.limitations,
          ...(execution.value.relationshipCoverage === undefined
            ? {}
            : {
                relationshipCoverage: execution.value.relationshipCoverage,
              }),
          locations: execution.value.locations,
        },
      );
      const recorded = this.recordEvidence(evidence);
      if (!recorded.ok) return recorded;
      if (execution.value.cachePolicy !== "live")
        this.recordSnapshot({
          target: active.target,
          profile,
          operation: name,
          parameters: arguments_,
          execution: execution.value,
        });
    }
    return execution;
  }

  #observeRuntimeAvailability(
    operation: AnalysisOperation,
    result: Result<AnalysisExecution, AnalysisError>,
  ): void {
    if (result.ok) {
      if (this.#markRuntimeAvailable(operation))
        this.#emitAvailabilityChanged();
      return;
    }
    if (result.error._tag === "AnalysisCapabilityUnavailableError") {
      if (this.#markRuntimeUnavailable(operation, result.error.message))
        this.#emitAvailabilityChanged();
      return;
    }
    if (
      [
        "ProviderAdapterError",
        "HopperProcessError",
        "HopperStartError",
      ].includes(result.error._tag)
    ) {
      const capabilities = this.#active?.route.capabilities;
      const providerId = capabilities?.get(operation)?.provider.id;
      let changed = false;
      for (const descriptor of capabilities?.values() ?? [])
        if (providerId !== undefined && descriptor.provider.id === providerId)
          changed =
            this.#markRuntimeUnavailable(
              descriptor.operation,
              `${result.error._tag}: ${result.error.message}`,
            ) || changed;
      if (changed) this.#emitAvailabilityChanged();
    }
  }

  #markRuntimeAvailable(operation: string): boolean {
    return this.#runtimeUnavailability.delete(operation);
  }

  #markRuntimeUnavailable(operation: string, reason: string): boolean {
    const current = this.#runtimeUnavailability.get(operation);
    if (current?.reason === reason) return false;
    this.#runtimeUnavailability.set(operation, { reason });
    return true;
  }

  #clearRuntimeAvailability(): void {
    if (this.#runtimeUnavailability.size === 0) return;
    this.#runtimeUnavailability.clear();
    this.#emitAvailabilityChanged();
  }

  #emitAvailabilityChanged(): void {
    for (const listener of this.#availabilityListeners) {
      try {
        const notification = listener();
        if (notification !== undefined) {
          // best-effort cleanup: async observer notifications must not reject
          // unhandled; state transitions and other listeners continue.
          void notification.catch(() => undefined);
        }
      } catch (cause: unknown) {
        // External observers are best-effort notifications. Contain only the
        // callback failure so state transitions and other listeners continue.
        void cause;
      }
    }
  }

  #currentRoute(): SessionProviderRoute {
    return this.#active?.route ?? this.#providerRouter.initialRoute();
  }

  /** The transition the current requests wait for. */
  #admission(): TransitionAdmission {
    return {
      promise: this.#transition,
      epoch: this.#transitionEpoch,
      retirement: this.#epochRetirement,
    };
  }

  #serialize<Value>(
    operationName: string,
    operation: (
      admittedThrough: number,
    ) => Promise<Result<Value, AnalysisError>>,
  ): Promise<Result<Value, AnalysisError>> {
    for (const controller of this.#promptCompletionControllers)
      controller.abort();
    const epoch = this.#transitionEpoch;
    this.#transitionPending += 1;
    // Later calls wait for this transition and must not be included in its drain.
    const admittedThrough = this.#transitionGeneration++;
    const { settled } = waitForAdmission({
      promise: this.#transition,
      epoch,
      retirement: this.#epochRetirement,
    });
    const result = settled.then(() =>
      this.#admit(epoch, operationName, operation, admittedThrough),
    );
    this.#transition = result.then(
      () => undefined,
      () => undefined,
    );
    void result.then(
      () => {
        this.#settlePending(epoch);
      },
      () => {
        this.#settlePending(epoch);
      },
    );
    return result;
  }

  /**
   * Run a queued request, unless the transition it waited for was retired.
   *
   * A retired transition means the lifecycle the request addressed is gone.
   * The request reports that it was cancelled instead of running against the
   * target that took its place.
   */
  async #admit<Value>(
    epoch: number,
    operationName: string,
    operation: (
      admittedThrough: number,
    ) => Promise<Result<Value, AnalysisError>>,
    admittedThrough: number,
  ): Promise<Result<Value, AnalysisError>> {
    if (epoch !== this.#transitionEpoch)
      return err(new AnalysisCancelledError(operationName));
    return operation(admittedThrough);
  }

  /** Give back the pending count of a request that settled. */
  #settlePending(epoch: number): void {
    // A retired epoch gave its pending count back when it was retired.
    if (epoch !== this.#transitionEpoch) return;
    this.#transitionPending -= 1;
  }

  /**
   * Retire the transition chain and the requests that were queued behind it.
   *
   * A provider start that never unwinds holds the chain that carried it, and
   * that chain can never settle. The chain is replaced so the slot stays
   * usable, and the requests that were queued behind the abandoned start are
   * retired with it: they addressed the target the forced close took away,
   * so they must not run against the target that replaces it. The abandoned
   * start stops counting as a pending request, so the requests that read the
   * session are not blocked by a start that will never finish.
   */
  #retireTransition(): void {
    this.#transitionEpoch += 1;
    this.#transitionPending = 0;
    this.#epochRetirement.retire();
    this.#epochRetirement = this.#createRetirement();
    this.#transition = Promise.resolve();
  }

  async #drainCalls(admittedThrough: number): Promise<void> {
    await Promise.allSettled(
      [...this.#calls]
        .filter(([, generation]) => generation <= admittedThrough)
        .map(([call]) => call),
    );
  }

  /**
   * Probe whether a retained provider client is still live.
   *
   * On production routes the client is a CompositeProvider whose `health`
   * answers unconditionally ok without touching a child, so `health` alone
   * cannot see a dead child. `operationHealthSnapshot` reaches the
   * instantiated children instead. Only the known-live states allow the
   * fast path: `exited`/`unreachable` are dead, `unknown` is never
   * evidence of health (it is what a recorded but uncharacterized failure
   * reports), and `not_started` is a startup that never completed — in the
   * Hopper timeout case the client holds retained resources that block the
   * next `start()` until `close()` retries cleanup, so treating it as live
   * would skip the retire path and hand the wedged client to subsequent
   * analysis. The gate fails closed: without a snapshot signal, fall back
   * to the `health` admission probe.
   */
  async #retainedClientLive(
    client: AnalysisClient,
    options: Pick<BinarySessionOpenOptions, "signal">,
  ): Promise<boolean> {
    if (client.reuseReadiness?.() === "blocked") return false;
    const snapshot = client.operationHealthSnapshot?.();
    if (snapshot !== undefined)
      return snapshot.state === "idle" || snapshot.state === "busy";
    try {
      return (await client.execute("health", {}, options)).ok;
    } catch {
      return false;
    }
  }

  /**
   * Restore the target an open replaced.
   *
   * The restoration belongs to the slot that still owns the target: a forced
   * close retired that slot while the open was in flight, and a target
   * restored into a closed slot would take the slot back from the target that
   * replaced it. The check holds through the wait for the restored client,
   * because a close that runs while the restoration waits closes the slot the
   * restoration would bind.
   *
   * The restored client carries the admission of this session, so the
   * provider start it defers runs under the shared limit like every other
   * start of this session. Without it, the restored target starts its
   * provider beside one that is still starting, and the analysis cap is
   * exceeded.
   *
   * The restoration does not start the provider under that admission: the
   * health probe of a composed client answers without touching a child, and a
   * probe that waited for the limit would make a cancelled open wait for a
   * permit it cannot use.
   */
  async #restore(
    previous: SessionBinding | undefined,
    generation: number,
  ): Promise<Result<null, AnalysisError>> {
    if (previous === undefined) return ok(null);
    if (generation !== this.#lifecycleGeneration) return ok(null);
    const runId = randomUUID();
    const client = previous.route.createClient(previous.target, {
      runId,
      // The restored client starts the provider it defers under the shared
      // start limit, so a query on the restored target cannot launch a
      // provider beside one that is still starting.
      ...(this.#startAdmission === undefined
        ? {}
        : { startAdmission: this.#startAdmission }),
    });
    const run: SessionRun = {
      client,
      route: previous.route,
      runId,
      released: false,
    };
    const started = await client.execute("health", {});
    if (started.ok) {
      if (generation !== this.#lifecycleGeneration) {
        // The slot was closed while the restoration waited, so the restored
        // client is released instead of bound to a closed slot.
        const released = await this.#retireClient(run);
        return released.ok ? ok(null) : err(released.error);
      }
      this.#active = {
        target: previous.target,
        profile: previous.profile,
        ...run,
        nativeSourceAdmitted: false,
      };
      this.#clearRuntimeAvailability();
      return ok(null);
    }
    const closed = await this.#retireClient(run);
    return closed.ok
      ? ok(null)
      : err(
          analysisErrorWithCleanupFailure(
            started.error,
            closed.error,
            "open_binary",
          ),
        );
  }

  async #waitForTransition(
    operation: string,
    signal: AbortSignal | undefined,
    admission: TransitionAdmission,
  ): Promise<Result<undefined, AnalysisCancelledError>> {
    if (signal?.aborted === true)
      return err(new AnalysisCancelledError(operation));
    // A retired transition settles the wait: the request it carried is
    // rejected instead of waiting for a chain that will never settle.
    const { settled, detach } = waitForAdmission(admission);
    if (signal === undefined) {
      await settled;
      return this.#transitionOutcome(operation, admission);
    }
    return new Promise((resolve) => {
      const onAbort = (): void => {
        // The request stops waiting, so it leaves the epoch behind.
        detach();
        resolve(err(new AnalysisCancelledError(operation)));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void settled.then(() => {
        detach();
        signal.removeEventListener("abort", onAbort);
        resolve(
          signal.aborted
            ? err(new AnalysisCancelledError(operation))
            : this.#transitionOutcome(operation, admission),
        );
      });
    });
  }

  /**
   * The outcome of a request that waited for a transition.
   *
   * A retired transition took away the target the request addressed, so the
   * request reports that it was cancelled instead of running against the
   * target that took its place.
   */
  #transitionOutcome(
    operation: string,
    admission: TransitionAdmission,
  ): Result<undefined, AnalysisCancelledError> {
    if (admission.epoch !== this.#transitionEpoch)
      return err(new AnalysisCancelledError(operation));
    return ok(undefined);
  }
}

/**
 * Wait for the transition chain of an epoch or for the retirement of the epoch.
 *
 * The retirement is shared by every request of the epoch, so the wait
 * attaches a listener and detaches it when the wait finishes. A request that
 * settled for another reason leaves nothing attached to the retirement, so a
 * long-lived epoch does not retain the requests that already finished.
 */
const waitForAdmission = (
  admission: TransitionAdmission,
): { readonly settled: Promise<void>; readonly detach: () => void } => {
  let detach: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    const detachListener = admission.retirement.subscribe(() => resolve());
    detach = detachListener;
    void admission.promise.then(
      () => {
        detachListener();
        resolve();
      },
      () => {
        detachListener();
        resolve();
      },
    );
  });
  return { settled, detach: () => detach() };
};

const isAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;
