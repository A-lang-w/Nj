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
 docs/apk-signature-grammar-final
import { createEvidence, type Evidence, type EvidenceLocation, type EvidenceSubjectTarget } from "../domain/evidence.js";

import {
  createEvidence,
  type Evidence,
  type EvidenceLocation,
  type EvidenceSubjectTarget,
} from "../domain/evidence.js";
 main
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
  readonly selectorOrigin?: "provider";
}

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

export interface AnalysisExecution {
  readonly result: JsonValue;
  readonly rawResult: JsonValue | null;
  readonly provider: ProviderIdentity;
  readonly analysisProfile?: AnalysisProfileCommitment;
  readonly limitations: readonly string[];
  readonly relationshipCoverage?: RelationshipCoverage;
  readonly referencesTruncated?: boolean;
  readonly locations: readonly EvidenceLocation[];
  readonly subject: EvidenceSubjectTarget | null;
}

interface CreateAnalysisExecutionOptions {
  readonly rawResult?: unknown;
  readonly analysisProfile?: AnalysisProfileCommitment;
  readonly limitations?: readonly string[];
  readonly relationshipCoverage?: RelationshipCoverage;
  readonly referencesTruncated?: boolean;
  readonly locations?: readonly EvidenceLocation[];
  readonly subject?: EvidenceSubjectTarget;
}

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
    subject: options.subject ?? null,
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
 docs/apk-signature-grammar-final
  confidence: "observed" | "derived" = "observed",
): Evidence =>
    createEvidence(execution.subject ?? undefined, execution.provider, {

  confidence: "observed" | "derived",
): Evidence =>
  createEvidence(execution.subject ?? undefined, execution.provider, {
 main
    operation,
    parameters: jsonObjectSchema.parse(input),
    result: execution.result,
    rawResult: execution.rawResult,
    limitations: execution.limitations,
    locations: execution.locations,
    confidence,
 docs/apk-signature-grammar-final
    ...(execution.analysisProfile !== undefined
      ? { analysisProfile: execution.analysisProfile }
      : {}),
  });


  });

/** Provider-neutral application capability for one analysis operation. */
 main
export interface AnalysisOperationPort {
  execute(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>>;
}

export interface ProviderRuntimeLineageSnapshot {
  readonly provider: ProviderIdentity;
  readonly observation: ProcessLineageObservation;
}

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

export interface AnalysisClient extends AnalysisOperationPort {
  executeIfReady?(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError> | undefined>;
  runtimeLineageSnapshots?(): readonly ProviderRuntimeLineageSnapshot[];
  requestActivitySnapshots?(): readonly ProviderRequestActivitySnapshot[];
 docs/apk-signature-grammar-final

  /** Local reuse admission is separate from observed native process health. */
  reuseReadiness?(): "ready" | "blocked" | "unknown";
  /** Current operational health for the active provider bridge. */
 main
  operationHealthSnapshot?(): ProviderOperationHealth | undefined;
  close(
    options?: Pick<ExecutionOptions, "progress"> & {
      readonly retainDocument?: boolean;
    },
  ): Promise<Result<null, AnalysisError>>;
}

export interface AnalysisClientContext {
  readonly runId: string;
}

export interface FileCloseResourceOwner {
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

export interface AnalysisProfileResolution {
  readonly profile: AnalysisProfileCommitment | null;
}

 docs/apk-signature-grammar-final
export interface AnalysisProfileResolutionOptions {

/** Cancellation context for side-effect-free provider profile resolution. */
export interface AnalysisProviderInspectionOptions {
 main
  readonly signal?: AbortSignal;
  readonly scope?: ProviderInspectionScope;
}

export interface AnalysisProfileResolutionOptions extends AnalysisProviderInspectionOptions {
  readonly fileCloseResources?: FileCloseResourceOwner;
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
  readonly cachePolicy?: "snapshot" | "live";
  readonly provider: ProviderIdentity;
  readonly operation: Exclude<AnalysisOperation, "health">;
  readonly effects: CapabilityEffects;
  readonly limitations: readonly string[];
};

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

export type ProviderTargetSupport =
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

export interface AnalysisProviderReadinessSnapshot {
  readonly availability: ProviderAvailability;
  readonly capabilities: readonly CapabilityDescriptor[];
}

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
  hasPendingOwnedResources?(): boolean;
  closeOwnedResources?(): Promise<Result<null, AnalysisError>>;
}