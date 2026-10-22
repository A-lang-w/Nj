import type { EvidenceCreationOptions } from "../domain/evidence.js";
import type { ProviderInspectionScope } from "../providers/ProviderInspectionScope.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import type { OfficialToolName } from "../contracts/officialToolContracts.js";
import type { EnhancedToolName } from "../contracts/enhancedInputs.js";
import type { NativeToolName } from "../contracts/native/nativeToolContracts.js";
import type { ArtifactAnalysisOperation } from "../contracts/artifactToolContracts.js";
import type { ManagedToolName } from "../contracts/managed/managedToolContracts.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { Result } from "../domain/result.js";
import {
  createEvidence,
  type Evidence,
  type EvidenceLocation,
  type EvidenceSubjectTarget,
} from "../domain/evidence.js";
import { jsonObjectSchema, jsonValueSchema } from "../domain/jsonValue.js";
import type { ProgressReporter } from "./ProgressReporter.js";
import type { ProviderRejectionCode } from "../contracts/providerSelection.js";
import type { ProcessLineageObservation } from "../process/ProcessOwnership.js";
import type { ProviderOperationHealth } from "../domain/providerOperationHealth.js";
import {
  relationshipCoverageSchema,
  type RelationshipCoverage,
} from "../domain/relationshipCoverage.js";

export interface ExecutionOptions {
  readonly signal?: AbortSignal;
  readonly progress?: ProgressReporter;
  /**
   * Set when a procedure selector came from provider output, such as a
   * revisited callee, rather than from the caller. A provider-derived
   * selector is never the caller's input mistake. Absent means the caller
   * supplied it.
   */
  readonly selectorOrigin?: "provider";
  /** Route to one registered target slot; absent addresses the current slot. */
  readonly targetId?: string;
  /** Bound how long a call waits for a starting target before reporting progress. */
  readonly waitMs?: number;
}

/** Closed operations accepted by provider-backed analysis sessions. */
export type AnalysisOperation =
  | OfficialToolName
  | EnhancedToolName
  | NativeToolName
  | ArtifactAnalysisOperation
  | ManagedToolName
  // Provider aggregate and composed public overview have distinct Evidence and
  // snapshot identities. This capability does not add a CLI/MCP tool.
  | "read_binary_inventory_summary"
  | "health";

/** Atomic successful provider observation with exact producing provenance. */
export interface AnalysisExecution {
  readonly result: JsonValue;
  readonly rawResult: JsonValue | null;
  readonly provider: ProviderIdentity;
  readonly analysisProfile?: AnalysisProfileCommitment;
  /** Result-specific veto of snapshot replay; Evidence remains retainable. */
  readonly cachePolicy?: "live";
  readonly limitations: readonly string[];
  /** Provider-owned completeness assessment for caller/callee observations. */
  readonly relationshipCoverage?: RelationshipCoverage;
  /**
   * Whether the provider capped an `xrefs` read: true when it reported a
   * truncation, false when it explicitly reported none. Absent when it reports
   * nothing, which is not a completeness claim. Never part of Evidence or tool
   * output.
   */
  readonly referencesTruncated?: boolean;
  readonly locations: readonly EvidenceLocation[];
  /**
   * Missing means the selected operation's default subject should be bound by
   * its caller. Explicit null means the observation has no file subject.
   */
  readonly subject?: EvidenceSubjectTarget | null;
}

interface CreateAnalysisExecutionOptions {
  readonly rawResult?: unknown;
  readonly analysisProfile?: AnalysisProfileCommitment;
  readonly cachePolicy?: "live";
  readonly limitations?: readonly string[];
  readonly relationshipCoverage?: RelationshipCoverage;
  readonly referencesTruncated?: boolean;
  readonly locations?: readonly EvidenceLocation[];
  readonly subject?: EvidenceSubjectTarget | null;
}

/**
 * Build a validated atomic provider observation at an adapter boundary.
 *
 * Pass `rawResult` only for a provider representation distinct from
 * `result`. Omitting it records `null` rather than a second complete copy of
 * the normalized result in every Evidence record and tool response.
 */
export function createAnalysisExecution<Subject extends EvidenceSubjectTarget>(
  result: unknown,
  provider: ProviderIdentity,
  options: CreateAnalysisExecutionOptions & { readonly subject: Subject },
): Omit<AnalysisExecution, "subject"> & { readonly subject: Subject };
export function createAnalysisExecution(
  result: unknown,
  provider: ProviderIdentity,
  options?: CreateAnalysisExecutionOptions,
): AnalysisExecution;
export function createAnalysisExecution(
  result: unknown,
  provider: ProviderIdentity,
  options: CreateAnalysisExecutionOptions = {},
): AnalysisExecution {
  return {
    result: jsonValueSchema.parse(result),
    rawResult:
      options.rawResult === undefined
        ? null
        : jsonValueSchema.parse(options.rawResult),
    provider,
    ...(options.cachePolicy === undefined
      ? {}
      : { cachePolicy: options.cachePolicy }),
    ...(options.analysisProfile === undefined
      ? {}
      : { analysisProfile: structuredClone(options.analysisProfile) }),
    limitations: [...(options.limitations ?? [])],
    ...(options.relationshipCoverage === undefined
      ? {}
      : {
          relationshipCoverage: relationshipCoverageSchema.parse(
            options.relationshipCoverage,
          ),
        }),
    ...(options.referencesTruncated === undefined
      ? {}
      : { referencesTruncated: options.referencesTruncated }),
    locations: [...(options.locations ?? [])],
    ...(options.subject === undefined ? {} : { subject: options.subject }),
  };
}

/**
 * Compose one completed provider execution into its caller-visible Evidence,
 * so success and a late cancellation that retains it carry identical facts.
 */
export const createAnalysisExecutionEvidence = (
  operation: string,
  input: unknown,
  execution: AnalysisExecution,
  confidence: "observed" | "derived",
  options?: EvidenceCreationOptions,
): Evidence =>
  createEvidence(
    execution.subject === undefined
      ? undefined
      : (execution.subject ?? undefined),
    execution.provider,
    {
      operation,
      parameters: jsonObjectSchema.parse(input),
      result: execution.result,
      rawResult: execution.rawResult,
      limitations: execution.limitations,
      ...(execution.analysisProfile === undefined
        ? {}
        : { analysisProfile: execution.analysisProfile }),
      ...(execution.relationshipCoverage === undefined
        ? {}
        : { relationshipCoverage: execution.relationshipCoverage }),
      locations: execution.locations,
      confidence,
    },
    options,
  );

/** Provider-neutral application capability for one analysis operation. */
export interface AnalysisOperationPort {
  execute(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>>;
}

/** Retained provider-process observation attributed to its producing provider. */
export interface ProviderRuntimeLineageSnapshot {
  readonly provider: ProviderIdentity;
  readonly observation: ProcessLineageObservation;
}

/** One provider's current serial-request activity, including detached callers. */
export interface ProviderRequestActivitySnapshot {
  readonly provider: ProviderIdentity;
  readonly active: {
    readonly requestId: number;
    readonly operation: string;
    readonly elapsedMs: number;
    readonly callerState: "waiting" | "cancelled";
  } | null;
  readonly queuedRequests: number;
}

/** Provider session bound to exactly one parsed artifact. */
export interface AnalysisClient extends AnalysisOperationPort {
  /** Execute only if this operation can run without loading or starting a provider. */
  executeIfReady?(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError> | undefined>;
  /**
   * Start the provider this client selected, when the client defers it.
   *
   * A composed client answers a health probe without touching a child, so a
   * caller that needs the provider running asks for that start explicitly.
   * A client that starts its provider with its first call has nothing to do
   * here and does not implement it.
   */
  startProvider?(
    options?: ExecutionOptions,
  ): Promise<Result<null, AnalysisError>>;
  /** Retained token-verified process snapshots for dynamic providers this client started. */
  runtimeLineageSnapshots?(): readonly ProviderRuntimeLineageSnapshot[];
  /** Current provider work that may outlive a timed-out or cancelled caller. */
  requestActivitySnapshots?(): readonly ProviderRequestActivitySnapshot[];
  /** Local reuse admission is separate from observed native process health. */
  reuseReadiness?(): "ready" | "blocked" | "unknown";
  /** Current operational health for the active provider bridge. */
  operationHealthSnapshot?(): ProviderOperationHealth | undefined;
  /** Close owned resources and retain failed cleanup for a later retry. */
  close(
    options?: Pick<ExecutionOptions, "progress"> & {
      readonly retainDocument?: boolean;
      /** Report each owned cleanup failure as soon as its owner observes it. */
      readonly onCleanupFailure?: (failure: AnalysisError) => void;
    },
  ): Promise<Result<null, AnalysisError>>;
}

/**
 * The shared admission that bounds a provider start.
 *
 * A client that defers its start runs it under this admission, and an open
 * that starts the provider it selected runs that start under it too, so a
 * limit that counts provider starts counts the real ones instead of only the
 * opens that resolved a target. The admission takes the limit around the
 * start and gives it back when the start settles.
 */
export interface ProviderStartAdmission {
  /**
   * Run one provider start under the shared start limit.
   *
   * The admission reports the start's own failure. It never starts a
   * provider twice and never runs the start without the limit.
   *
   * A failed start leaves a provider behind, and the cleanup of that failed
   * start owns the provider: it either releases it or keeps it for a later
   * retry. The cleanup runs under the same limit, so the limit counts the
   * provider while it may still be running. A start without a cleanup gives
   * the limit back when the start settles.
   *
   * The admission runs the cleanup for every failure it reports, including a
   * start it could not attempt because the limit could not be acquired: the
   * open still owns a client it created and a target it replaced, and the
   * cleanup is what releases them. The admission reports the failure the
   * cleanup answered with.
   */
  run<Value>(
    start: () => Promise<Result<Value, AnalysisError>>,
    operation: string,
    signal?: AbortSignal,
    cleanup?: (failure: AnalysisError) => Promise<ProviderStartCleanup>,
  ): Promise<Result<Value, AnalysisError>>;
}

/**
 * What the cleanup of a failed start reports to the start admission.
 *
 * The cleanup is the owner of the provider the failed start left behind, so
 * it reports whether that provider may still be running.
 */
export interface ProviderStartCleanup {
  /** The failure the failed start reports to its caller. */
  readonly error: AnalysisError;
  /**
   * True when the provider the failed start left behind may still be running.
   *
   * The admission keeps the limit for that provider until a later cleanup
   * releases it, so the analysis cap counts a provider that is still alive.
   */
  readonly providerAlive: boolean;
}

/** Per-client identity allocated before any provider side effect starts. */
export interface AnalysisClientContext {
  readonly runId: string;
  /**
   * The admission that bounds a start this client defers.
   *
   * A client that starts its provider with a later call runs that call
   * under this admission, so the shared start limit covers the real start.
   */
  readonly startAdmission?: ProviderStartAdmission;
}

/** One lifecycle owner for retained resources and abortable inspection work. */
export interface RetainedResourceScope {
  retain(
    owner: {
      close(): Promise<void>;
      /** Complete labels authored by this exact owner; the display label is only a fallback. */
      readonly cleanupResources?: readonly string[] | undefined;
    },
    resource: string,
  ): void;
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export interface ProviderIdentity {
  readonly id: string;
  readonly name: string;
  readonly version: string | null;
}

/** Typed analysis profile resolved before provider startup; null means unresolved. */
export interface AnalysisProfileResolution {
  readonly profile: AnalysisProfileCommitment | null;
  /** Keep provider-private facts bound to this selection without Evidence serialization. */
  readonly createClient?: AnalysisProviderBoundClientFactory;
}

export type AnalysisProviderBoundClientFactory = (
  target: BinaryTarget,
  profile: AnalysisProfileCommitment,
  context?: AnalysisClientContext,
) => AnalysisClient;

/** Cancellation context for side-effect-free provider profile resolution. */
export interface AnalysisProviderInspectionOptions {
  readonly signal?: AbortSignal;
  readonly scope?: ProviderInspectionScope;
  readonly resourceScope?: RetainedResourceScope;
}

export interface AnalysisProfileResolutionOptions extends AnalysisProviderInspectionOptions {
  readonly resourceScope?: RetainedResourceScope;
}

interface CapabilityEffects {
  readonly mutatesArtifact: boolean;
  readonly launchesProcess: boolean;
  readonly mayShowUi: boolean;
  readonly mayAccessNetwork: boolean;
  readonly mayWriteFilesystem: boolean;
  readonly changesPermissions: boolean;
  readonly requiresRoot: boolean;
}

type CapabilityAvailability =
  | {
      readonly available: true;
      readonly reason: null;
      readonly availabilityCode?: null;
    }
  | {
      readonly available: false;
      readonly reason: string;
      readonly availabilityCode?: ProviderRejectionCode;
    };

export type CapabilityDescriptor = CapabilityAvailability & {
  /**
   * Snapshot opts immutable, profile-bound reads into replay despite incidental
   * private filesystem writes. Live state must always be re-observed. Omitting
   * this policy retains conservative effect checks; mutation and UI-state
   * exclusions apply to every policy.
   */
  readonly cachePolicy?: "snapshot" | "live";
  /** Exact source profile for an operation implemented by a versioned local reader. */
  readonly analysisProfile?: AnalysisProfileCommitment;
  readonly provider: ProviderIdentity;
  readonly operation: Exclude<AnalysisOperation, "health">;
  readonly effects: CapabilityEffects;
  readonly limitations: readonly string[];
};

/** Factory and capability declaration for an analysis implementation. */
export interface AnalysisProvider {
  identity(): ProviderIdentity;
  capabilities(): readonly CapabilityDescriptor[];
  resolveAnalysisProfile?(
    target: BinaryTarget,
    options?: AnalysisProfileResolutionOptions,
  ): Promise<Result<AnalysisProfileResolution, AnalysisError>>;
  createClient(
    target: BinaryTarget,
    profile?: AnalysisProfileCommitment,
    context?: AnalysisClientContext,
  ): AnalysisClient;
}

/** Bounded host observation made without starting an analysis process. */
export type ProviderAvailability =
  | {
      readonly status: "available";
      readonly code: null;
      readonly reason: null;
      readonly diagnostics: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly status: "unavailable";
      readonly code: ProviderRejectionCode;
      readonly reason: string;
      readonly diagnostics: Readonly<Record<string, JsonValue>>;
    };

/** Provider-owned target support observation before profile resolution. */
export type ProviderTargetSupport =
  | {
      readonly status: "unknown";
      readonly code: null;
      readonly reason: string;
      readonly diagnostics: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly status: "supported";
      readonly code: null;
      readonly reason: null;
      readonly diagnostics: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly status: "unsupported";
      readonly code:
        | "target_kind_unsupported"
        | "target_format_unsupported"
        | "architecture_unsupported"
        | "target_role_unsupported"
        | "managed_target_unsupported";
      readonly reason: string;
      readonly diagnostics: Readonly<Record<string, JsonValue>>;
    };

/** One owner-observed availability/capability snapshot for provider discovery. */
export interface AnalysisProviderReadinessSnapshot {
  readonly availability: ProviderAvailability;
  readonly capabilities: readonly CapabilityDescriptor[];
}

/** Deep provider candidate discoverable before one target-bound route is chosen. */
export interface AnalysisProviderCandidate extends AnalysisProvider {
  /**
   * Own inspection through final reads and cleanup. Observe the supplied owner
   * signal cooperatively; resolve only after finalization settles, retaining any
   * failed cleanup capability. Registry cancellation and shutdown join this
   * completion rather than abandoning the promise.
   */
  resolveAnalysisProfile(
    target: BinaryTarget,
    options?: AnalysisProfileResolutionOptions,
  ): Promise<Result<AnalysisProfileResolution, AnalysisError>>;
  /** Await prerequisite observations and finalization under the supplied owner signal. */
  inspectAvailability(
    options?: AnalysisProviderInspectionOptions,
  ): ProviderAvailability | Promise<ProviderAvailability>;
  inspectReadinessSnapshot?(
    options?: AnalysisProviderInspectionOptions,
  ):
    | AnalysisProviderReadinessSnapshot
    | Promise<AnalysisProviderReadinessSnapshot>;
  inspectTargetSupport(target: BinaryTarget): ProviderTargetSupport;
  inspectTargetSupportWithOptions?(
    target: BinaryTarget,
    options?: AnalysisProviderInspectionOptions,
  ): Promise<ProviderTargetSupport>;
  /** Observe retained candidate cleanup without starting or retrying work. */
  hasPendingOwnedResources?(): boolean;
  /** Release candidate resources that are independent of any active client. */
  closeOwnedResources?(): Promise<Result<null, AnalysisError>>;
}
