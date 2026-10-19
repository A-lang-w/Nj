import { randomUUID } from "node:crypto";

import type { AnalysisProfileCommitment } from "../../domain/analysisProfile.js";
import type { AnalysisSnapshot } from "../../domain/analysisSnapshot.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisResourceConstraintError,
  AnalysisTargetNotOpenError,
} from "../../domain/analysisErrorCore.js";
import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";
import type { Evidence } from "../../domain/evidence.js";
import type { EvidenceBundle } from "../../domain/evidenceBundle.js";
import type { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import type {
  ResolvedSessionOpen,
} from "./BinarySessionOpen.js";
import { BinarySession } from "./BinarySession.js";
import type {
  BinarySessionPort,
  SavedAnalysisSnapshot,
} from "./BinarySessionPort.js";
import type { SessionProviderRouter } from "./SessionProviderRouter.js";
import { InvestigationRecords } from "../investigation/InvestigationRecords.js";
import type {
  AnalysisExecution,
  AnalysisOperation,
  AnalysisOperationPort,
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type {
  UnknownPage,
  UnknownQuery,
} from "../investigation/InvestigationRecordPort.js";
import type {
  RecordUnknownInput,
  ResidualUnknown,
  UnknownStatus,
  UpdateUnknownInput,
} from "../../domain/residualUnknown.js";
import type { UnknownRegistryError } from "../../domain/unknownRegistryError.js";
import type { WorkflowSnapshotRecordInput } from "./BinarySessionRecords.js";

/** Bounded target and analysis concurrency supplied by the composition root. */
export interface BinaryTargetLimits {
  readonly maxOpenTargets: number;
  readonly maxConcurrentAnalyses: number;
}

const DEFAULT_LIMITS: BinaryTargetLimits = {
  maxOpenTargets: 4,
  maxConcurrentAnalyses: 2,
};

interface TargetSlot {
  readonly id: string;
  readonly session: BinarySession;
}

/**
 * Own several independent target sessions behind one `BinarySessionPort`.
 *
 * Each slot keeps the single-target lifecycle lock, provider client, snapshot
 * cache, and cancellation scope it had when `BinarySession` owned the whole
 * server. The registry routes each call to one slot and bounds how many slots
 * and simultaneous starts may exist. A call without `target_id` addresses the
 * current slot, so single-target clients keep the replacement behaviour.
 */
export class BinaryTargetRegistry implements BinarySessionPort {
  readonly #router: SessionProviderRouter;
  readonly #records: InvestigationRecords;
  readonly #limits: BinaryTargetLimits;
  readonly #slots = new Map<string, TargetSlot>();
  readonly #availabilityListeners = new Set<() => void | Promise<void>>();
  readonly #snapshotListeners = new Set<() => void | Promise<void>>();
  #primary: TargetSlot;
  #currentId: string;
  #activeStarts = 0;
  readonly #startQueue: Array<() => void> = [];

  constructor(
    router: SessionProviderRouter,
    records: InvestigationRecords = new InvestigationRecords(),
    limits: Partial<BinaryTargetLimits> = {},
  ) {
    this.#router = router;
    this.#records = records;
    this.#limits = {
      maxOpenTargets: Math.max(
        1,
        limits.maxOpenTargets ?? DEFAULT_LIMITS.maxOpenTargets,
      ),
      maxConcurrentAnalyses: Math.max(
        1,
        limits.maxConcurrentAnalyses ?? DEFAULT_LIMITS.maxConcurrentAnalyses,
      ),
    };
    this.#primary = this.#createSlot();
    this.#currentId = this.#primary.id;
  }

  /** Currently open target handles in deterministic creation order. */
  targets(): readonly { readonly target_id: string; readonly target: BinaryTarget }[] {
    return [...this.#slots.values()].flatMap((slot) => {
      const target = slot.session.activeTarget();
      return target === undefined
        ? []
        : [{ target_id: slot.id, target }];
    });
  }

  /** Identifier of the target addressed when a call omits target_id. */
  currentTargetId(): string | undefined {
    return this.#slotById(this.#currentId)?.session.activeTarget() === undefined
      ? undefined
      : this.#currentId;
  }

  async open(
    path: string,
    options: Parameters<BinarySessionPort["open"]>[1] = {},
  ): Promise<Result<BinaryTarget, AnalysisError>> {
    if (options.keepOthersOpen !== true)
      return this.#openReplacing(path, options);
    const existing = this.#slotForPath(path);
    if (existing !== undefined) return this.#openInSlot(existing, path, options);
    return this.#openInNewSlot(path, options);
  }

  async openResolvedTarget(
    resolved: Pick<ResolvedSessionOpen, "target" | "route">,
    options: Parameters<BinarySessionPort["openResolvedTarget"]>[1] = {},
  ): Promise<Result<BinaryTarget, AnalysisError>> {
    if (options.keepOthersOpen !== true)
      return this.#openResolvedReplacing(resolved, options);
    const existing = this.#slotForPath(resolved.target.path);
    if (existing !== undefined)
      return this.#openResolvedInSlot(existing, resolved, options);
    return this.#openResolvedInNewSlot(resolved, options);
  }

  async #openReplacing(
    path: string,
    options: Parameters<BinarySessionPort["open"]>[1],
  ): Promise<Result<BinaryTarget, AnalysisError>> {
    const closed = await this.#closeSlotsExcept(this.#primary);
    if (!closed.ok) return closed;
    return this.#openInSlot(this.#primary, path, options);
  }

  async #openResolvedReplacing(
    resolved: Pick<ResolvedSessionOpen, "target" | "route">,
    options: Parameters<BinarySessionPort["openResolvedTarget"]>[1],
  ): Promise<Result<BinaryTarget, AnalysisError>> {
    const closed = await this.#closeSlotsExcept(this.#primary);
    if (!closed.ok) return closed;
    return this.#openResolvedInSlot(this.#primary, resolved, options);
  }

  async #openInNewSlot(
    path: string,
    options: Parameters<BinarySessionPort["open"]>[1],
  ): Promise<Result<BinaryTarget, AnalysisError>> {
    const capacity = this.#checkOpenCapacity("open_binary");
    if (capacity !== undefined) return capacity;
    return this.#openInSlot(this.#createSlot(), path, options);
  }

  async #openResolvedInNewSlot(
    resolved: Pick<ResolvedSessionOpen, "target" | "route">,
    options: Parameters<BinarySessionPort["openResolvedTarget"]>[1],
  ): Promise<Result<BinaryTarget, AnalysisError>> {
    const capacity = this.#checkOpenCapacity("open_binary");
    if (capacity !== undefined) return capacity;
    return this.#openResolvedInSlot(this.#createSlot(), resolved, options);
  }

  async #openInSlot(
    slot: TargetSlot,
    path: string,
    options: Parameters<BinarySessionPort["open"]>[1],
  ): Promise<Result<BinaryTarget, AnalysisError>> {
    const permit = await this.#acquireStartPermit("open_binary", options?.signal);
    if (!permit.ok) return err(permit.error);
    try {
      const opened = await slot.session.open(path, options);
      return this.#finishOpen(slot, opened);
    } finally {
      this.#releaseStartPermit();
    }
  }

  async #openResolvedInSlot(
    slot: TargetSlot,
    resolved: Pick<ResolvedSessionOpen, "target" | "route">,
    options: Parameters<BinarySessionPort["openResolvedTarget"]>[1],
  ): Promise<Result<BinaryTarget, AnalysisError>> {
    const permit = await this.#acquireStartPermit("open_binary", options?.signal);
    if (!permit.ok) return err(permit.error);
    try {
      const opened = await slot.session.openResolvedTarget(resolved, options);
      return this.#finishOpen(slot, opened);
    } finally {
      this.#releaseStartPermit();
    }
  }

  #finishOpen(
    slot: TargetSlot,
    opened: Result<BinaryTarget, AnalysisError>,
  ): Result<BinaryTarget, AnalysisError> {
    if (!opened.ok) {
      if (slot !== this.#primary && slot.session.activeTarget() === undefined)
        this.#removeSlot(slot);
      return opened;
    }
    this.#slots.set(slot.id, slot);
    this.#currentId = slot.id;
    return opened;
  }

  previewTarget(
    target: BinaryTarget,
    options: Parameters<BinarySessionPort["previewTarget"]>[1] = {},
  ): Promise<Result<ResolvedSessionOpen, AnalysisError>> {
    return this.#currentSlot().session.previewTarget(target, options);
  }

  close(
    options: Parameters<BinarySessionPort["close"]>[0] = {},
  ): Promise<Result<null, AnalysisError>> {
    return this.#closeSlotFor(options, (slot, behavior) =>
      slot.session.closeAsSlot(options, behavior),
    );
  }

  /** Close every slot; incomplete cleanup stays visible on the first failure. */
  async closeAll(
    options: Parameters<NonNullable<BinarySessionPort["closeAll"]>>[0] = {},
  ): Promise<Result<null, AnalysisError>> {
    let failure: AnalysisError | undefined;
    for (const slot of [...this.#slots.values()]) {
      const closed = await slot.session.closeAsSlot(options, {
        clearRecords: false,
        closeOwnedProviderResources: false,
      });
      if (!closed.ok) failure ??= closed.error;
      this.#retireSlot(slot);
    }
    const final = await this.#primary.session.closeAsSlot(options, {
      clearRecords: true,
      closeOwnedProviderResources: true,
    });
    if (!final.ok) failure ??= final.error;
    return failure === undefined ? ok(null) : err(failure);
  }

  closeWithSnapshot(
    path: string,
    overwrite: boolean,
    options: Parameters<BinarySessionPort["closeWithSnapshot"]>[2] = {},
  ): Promise<Result<SavedAnalysisSnapshot, AnalysisError>> {
    return this.#closeSlotFor(options, (slot, behavior) =>
      slot.session.closeWithSnapshotAsSlot(path, overwrite, options, behavior),
    );
  }

  async #closeSlotFor<Value>(
    options: { readonly targetId?: string; readonly signal?: AbortSignal },
    close: (
      slot: TargetSlot,
      behavior: {
        readonly clearRecords: boolean;
        readonly closeOwnedProviderResources: boolean;
      },
    ) => Promise<Result<Value, AnalysisError>>,
  ): Promise<Result<Value, AnalysisError>> {
    const slot = this.#resolveSlot(options.targetId, "close_binary");
    if (!slot.ok) return slot;
    const last = this.#openSlotCount() <= 1;
    const closed = await close(slot.value, {
      clearRecords: last,
      closeOwnedProviderResources: last,
    });
    if (closed.ok) this.#retireSlot(slot.value);
    return closed;
  }

  async status(
    options: Parameters<BinarySessionPort["status"]>[0] = {},
  ): Promise<JsonValue> {
    const slot = this.#resolveSlot(options?.targetId, "binary_session");
    if (!slot.ok) throw slot.error;
    const base = await slot.value.session.status(options);
    if (typeof base !== "object" || base === null || Array.isArray(base))
      return base;
    return {
      ...base,
      target_id: slot.value.id,
      open_target_ids: this.targets().map(({ target_id }) => target_id),
    };
  }

  execute(
    name: Parameters<AnalysisOperationPort["execute"]>[0],
    arguments_: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const slot = this.#resolveSlot(options?.targetId, name);
    if (!slot.ok) return Promise.resolve(slot);
    return slot.value.session.execute(name, arguments_, options);
  }

  executeIfProviderReady(
    name: Parameters<BinarySessionPort["executeIfProviderReady"]>[0],
    arguments_: Readonly<Record<string, JsonValue>>,
    options?: Pick<ExecutionOptions, "signal" | "selectorOrigin" | "targetId">,
  ): Promise<Result<AnalysisExecution, AnalysisError> | undefined> {
    const slot = this.#resolveSlot(options?.targetId, name);
    if (!slot.ok) return Promise.resolve(slot);
    return slot.value.session.executeIfProviderReady(name, arguments_, options);
  }

  withAdmittedAnalysis<Value>(
    operationName: string,
    signal: AbortSignal | undefined,
    operation: (analysis: AnalysisOperationPort) => Promise<Value>,
    targetId?: string,
  ): Promise<Result<Value, AnalysisError>> {
    const slot = this.#resolveSlot(targetId, operationName);
    if (!slot.ok) return Promise.resolve(slot);
    return slot.value.session.withAdmittedAnalysis(
      operationName,
      signal,
      operation,
    );
  }

  withAdmittedExternalMutation<Value>(
    path: string | undefined,
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
    const slot = this.#currentSlot();
    return slot.session.withAdmittedExternalMutation(
      path,
      signal,
      operation,
      retirementFailure,
      operationName,
      cleanupRecovery,
    );
  }

  activeTarget(targetId?: string): BinaryTarget | undefined {
    const slot = this.#resolveSlotResult(targetId);
    return slot.ok ? slot.value.session.activeTarget() : undefined;
  }

  providerIdentity(
    operation?: AnalysisOperation,
    targetId?: string,
  ): ProviderIdentity {
    return this.#currentSlot(targetId).session.providerIdentity(operation);
  }

  analysisProfile(
    operation?: AnalysisOperation,
    targetId?: string,
  ): AnalysisProfileCommitment | undefined {
    return this.#currentSlot(targetId).session.analysisProfile(operation);
  }

  allowsSnapshotReplay(
    operation: AnalysisOperation,
    targetId?: string,
  ): boolean {
    return this.#currentSlot(targetId).session.allowsSnapshotReplay(operation);
  }

  invalidateSnapshotForExternalMutation(targetId?: string): void {
    this.#currentSlot(targetId).session.invalidateSnapshotForExternalMutation();
  }

  exportAnalysisSnapshot(
    targetId?: string,
  ): Result<AnalysisSnapshot, AnalysisError> {
    return this.#currentSlot(targetId).session.exportAnalysisSnapshot();
  }

  importAnalysisSnapshot(
    snapshot: AnalysisSnapshot,
    targetId?: string,
  ): Result<number, AnalysisError> {
    return this.#currentSlot(targetId).session.importAnalysisSnapshot(snapshot);
  }

  recordWorkflowSnapshot(
    input: WorkflowSnapshotRecordInput,
    targetId?: string,
  ): Result<null, EvidenceIntegrityError> {
    return this.#currentSlot(targetId).session.recordWorkflowSnapshot(input);
  }

  onAvailabilityChanged(listener: () => void | Promise<void>): () => void {
    this.#availabilityListeners.add(listener);
    return () => this.#availabilityListeners.delete(listener);
  }

  onAnalysisSnapshotChanged(listener: () => void | Promise<void>): () => void {
    this.#snapshotListeners.add(listener);
    return () => this.#snapshotListeners.delete(listener);
  }

  // Investigation records stay session-wide. The current slot owns the target
  // binding used to attach new unknowns and the only active snapshot cache.
  recordEvidence(
    evidence: Evidence,
  ): ReturnType<BinarySessionPort["recordEvidence"]> {
    return this.#currentSlot().session.recordEvidence(evidence);
  }

  hasEvidence(evidenceId: string): boolean {
    return this.#currentSlot().session.hasEvidence(evidenceId);
  }

  evidenceById(evidenceId: string): Evidence | undefined {
    return this.#currentSlot().session.evidenceById(evidenceId);
  }

  evidenceForAnalysis(evidenceId: string): Evidence | undefined {
    return this.#currentSlot().session.evidenceForAnalysis(evidenceId);
  }

  exportEvidenceBundle(): EvidenceBundle {
    return this.#currentSlot().session.exportEvidenceBundle();
  }

  evidenceBundleForSerialization(): EvidenceBundle {
    return this.#currentSlot().session.evidenceBundleForSerialization();
  }

  writeAnalysisSnapshot(
    snapshot: AnalysisSnapshot,
    path: string,
    overwrite: boolean,
  ): ReturnType<BinarySession["writeAnalysisSnapshot"]> {
    return this.#currentSlot().session.writeAnalysisSnapshot(
      snapshot,
      path,
      overwrite,
    );
  }

  closeWriteResources(): Promise<Result<null, AnalysisError>> {
    return this.#currentSlot().session.closeWriteResources();
  }

  importEvidenceBundle(
    bundle: unknown,
  ): ReturnType<BinarySession["importEvidenceBundle"]> {
    return this.#currentSlot().session.importEvidenceBundle(bundle);
  }

  recordUnknown(
    input: RecordUnknownInput,
  ): Result<ResidualUnknown, AnalysisError> {
    return this.#currentSlot().session.recordUnknown(input);
  }

  recordEvidenceWithUnknown(
    evidence: Evidence,
    input: RecordUnknownInput,
  ): Result<ResidualUnknown | null, AnalysisError> {
    return this.#currentSlot().session.recordEvidenceWithUnknown(
      evidence,
      input,
    );
  }

  updateUnknown(
    input: UpdateUnknownInput,
  ): Result<ResidualUnknown, AnalysisError> {
    return this.#currentSlot().session.updateUnknown(input);
  }

  listUnknowns(
    filters: {
      readonly status?: UnknownStatus;
      readonly severity?: ResidualUnknown["severity"];
      readonly domain?: string;
    } = {},
  ): ResidualUnknown[] {
    return this.#currentSlot().session.listUnknowns(filters);
  }

  listUnknownsPage(query: UnknownQuery = {}): UnknownPage {
    return this.#currentSlot().session.listUnknownsPage(query);
  }

  verifyUnknownResolution(
    unknownId: string,
  ): Result<
    {
      readonly valid: boolean;
      readonly truthVerified: boolean;
      readonly unknown: ResidualUnknown;
    },
    UnknownRegistryError
  > {
    return this.#currentSlot().session.verifyUnknownResolution(unknownId);
  }

  #createSlot(): TargetSlot {
    const session = new BinarySession(this.#router, this.#records);
    const slot: TargetSlot = { id: randomUUID(), session };
    session.onAvailabilityChanged(() => this.#emitAvailabilityChanged());
    session.onAnalysisSnapshotChanged(() => this.#emitSnapshotChanged());
    return slot;
  }

  #removeSlot(slot: TargetSlot): void {
    this.#slots.delete(slot.id);
    if (this.#currentId === slot.id) this.#currentId = this.#primary.id;
  }

  #retireSlot(slot: TargetSlot): void {
    if (slot === this.#primary) {
      this.#slots.delete(slot.id);
      const replacement = this.#firstOpenSlot();
      if (replacement !== undefined) {
        this.#currentId = replacement.id;
        return;
      }
      this.#currentId = this.#primary.id;
      return;
    }
    this.#slots.delete(slot.id);
    if (this.#currentId === slot.id) {
      const replacement = this.#firstOpenSlot();
      this.#currentId = replacement?.id ?? this.#primary.id;
    }
  }

  #firstOpenSlot(): TargetSlot | undefined {
    return [...this.#slots.values()].find(
      ({ session }) => session.activeTarget() !== undefined,
    );
  }

  #openSlotCount(): number {
    let count = 0;
    for (const slot of this.#slots.values())
      if (slot.session.activeTarget() !== undefined) count += 1;
    return count;
  }

  #slotById(targetId: string): TargetSlot | undefined {
    if (this.#primary.id === targetId) return this.#primary;
    return this.#slots.get(targetId);
  }

  #slotForPath(path: string): TargetSlot | undefined {
    return [...this.#slots.values()].find(({ session }) => {
      const target = session.activeTarget();
      return target?.path === path || target?.sourcePath === path;
    });
  }

  #currentSlot(targetId?: string): TargetSlot {
    if (targetId !== undefined) {
      const slot = this.#slotById(targetId);
      if (slot !== undefined && slot.session.activeTarget() !== undefined)
        return slot;
      return this.#primary;
    }
    return this.#slotById(this.#currentId) ?? this.#primary;
  }

  #resolveSlot(
    targetId: string | undefined,
    operation: string,
  ): Result<TargetSlot, AnalysisError> {
    if (targetId === undefined) return ok(this.#slotById(this.#currentId) ?? this.#primary);
    const slot = this.#slotById(targetId);
    if (slot !== undefined && slot.session.activeTarget() !== undefined)
      return ok(slot);
    return err(
      new AnalysisTargetNotOpenError(
        operation,
        targetId,
        [...this.#slots.values()]
          .filter(({ session }) => session.activeTarget() !== undefined)
          .map(({ id }) => id),
      ),
    );
  }

  #resolveSlotResult(
    targetId: string | undefined,
  ): Result<TargetSlot, AnalysisError> {
    return this.#resolveSlot(targetId, "target lookup");
  }

  #checkOpenCapacity(
    operation: string,
  ): Result<never, AnalysisError> | undefined {
    if (this.#openSlotCount() < this.#limits.maxOpenTargets) return undefined;
    return err(
      new AnalysisResourceConstraintError(
        operation,
        "capacity",
        `Opening another target would exceed REA_MAX_OPEN_TARGETS=${this.#limits.maxOpenTargets}. Close an open target or raise the limit.`,
        { max_open_targets: this.#limits.maxOpenTargets },
        {
          remediationAction:
            "Close an open target with close_binary or raise REA_MAX_OPEN_TARGETS.",
        },
      ),
    );
  }

  async #closeSlotsExcept(
    keep: TargetSlot,
  ): Promise<Result<null, AnalysisError>> {
    for (const slot of [...this.#slots.values()]) {
      if (slot === keep) continue;
      const closed = await slot.session.closeAsSlot(
        {},
        { clearRecords: false, closeOwnedProviderResources: false },
      );
      if (!closed.ok) return closed;
      this.#retireSlot(slot);
    }
    return ok(null);
  }

  async #acquireStartPermit(
    operation: string,
    signal: AbortSignal | undefined,
  ): Promise<Result<undefined, AnalysisError>> {
    if (signal?.aborted === true)
      return err(new AnalysisCancelledError(operation));
    if (this.#activeStarts < this.#limits.maxConcurrentAnalyses) {
      this.#activeStarts += 1;
      return ok(undefined);
    }
    return new Promise((resolve) => {
      const grant = (): void => {
        this.#activeStarts += 1;
        resolve(ok(undefined));
      };
      if (signal === undefined) {
        this.#startQueue.push(grant);
        return;
      }
      const queued = (): void => {
        const index = this.#startQueue.indexOf(onGrant);
        if (index >= 0) this.#startQueue.splice(index, 1);
        resolve(err(new AnalysisCancelledError(operation)));
      };
      const onGrant = (): void => {
        signal.removeEventListener("abort", queued);
        grant();
      };
      signal.addEventListener("abort", queued, { once: true });
      this.#startQueue.push(onGrant);
    });
  }

  #releaseStartPermit(): void {
    this.#activeStarts = Math.max(0, this.#activeStarts - 1);
    const next = this.#startQueue.shift();
    next?.();
  }

  #emitAvailabilityChanged(): void {
    for (const listener of this.#availabilityListeners) {
      try {
        const notification = listener();
        if (notification !== undefined) void notification.catch(() => undefined);
      } catch (cause: unknown) {
        void cause;
      }
    }
  }

  #emitSnapshotChanged(): void {
    for (const listener of this.#snapshotListeners) {
      try {
        const notification = listener();
        if (notification !== undefined) void notification.catch(() => undefined);
      } catch (cause: unknown) {
        void cause;
      }
    }
  }
}
