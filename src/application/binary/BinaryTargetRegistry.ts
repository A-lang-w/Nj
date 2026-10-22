import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import type { AnalysisProfileCommitment } from "../../domain/analysisProfile.js";
import type { AnalysisSnapshot } from "../../domain/analysisSnapshot.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInProgressError,
  AnalysisResourceConstraintError,
  AnalysisTargetNotOpenError,
} from "../../domain/analysisErrorCore.js";
import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";
import type { Evidence } from "../../domain/evidence.js";
import type { EvidenceBundle } from "../../domain/evidenceBundle.js";
import type { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import type { ResolvedSessionOpen } from "./BinarySessionOpen.js";
import { sameSessionTarget } from "./BinarySessionOpen.js";
import { BinarySession } from "./BinarySession.js";
import { parseBinaryTarget } from "../BinaryTargetResolver.js";
import type {
  BinarySessionPort,
  BinaryBindingGuard,
  OpenedTarget,
  SavedAnalysisSnapshot,
} from "./BinarySessionPort.js";
import { binaryTargetSummary } from "./BinaryTargetSummary.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import type { SessionProviderRouter } from "./SessionProviderRouter.js";
import {
  externalMutationRefusal,
  refusesExternalMutation,
} from "./ExternalMutationAdmission.js";
import { InvestigationRecords } from "../investigation/InvestigationRecords.js";
import type {
  AnalysisExecution,
  AnalysisOperation,
  AnalysisOperationPort,
  ExecutionOptions,
  ProviderIdentity,
  ProviderStartAdmission,
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
import type { ResolvedAppBundleResourceRoot } from "../AppBundleExecutable.js";
import type { BundleResourceClientFactory } from "./BundleResourceSession.js";

/** Bounded target and analysis concurrency supplied by the composition root. */
export interface BinaryTargetLimits {
  readonly maxOpenTargets: number;
  readonly maxConcurrentAnalyses: number;
  readonly autoBackgroundAfterMs: number;
  /**
   * Bound on how long a close waits for an interrupted start to unwind.
   *
   * A provider start that ignores its abort holds the session's transition
   * promise, and the ordinary close serializes behind it. The close stops
   * waiting after this bound and releases the pending client through the
   * owner that stops the provider.
   */
  readonly jobSettleTimeoutMs: number;
}

const DEFAULT_LIMITS: BinaryTargetLimits = {
  maxOpenTargets: 4,
  maxConcurrentAnalyses: 2,
  autoBackgroundAfterMs: 120_000,
  jobSettleTimeoutMs: 30_000,
};

const DEFAULT_WAIT_MS = 180_000;
const MAX_WAIT_MS = 290_000;

interface TargetSlot {
  /**
   * The handle that addresses this slot's live target.
   *
   * A handle names one live target. A slot that takes on a different target
   * receives a new handle, so a handle that named the previous target never
   * selects its replacement.
   */
  id: string;
  readonly session: BinarySession;
  /** The target identity the current handle was minted for. */
  handleTarget: BinaryTarget | undefined;
  /**
   * The start permits the starts this slot runs hold.
   *
   * A permit is held while a provider start runs. A close that gave up on a
   * start that never unwound gives the permit back, and a close that could
   * not release the provider keeps it.
   */
  readonly startPermits: Set<StartPermit>;
  /**
   * The start permits a retained cleanup owns.
   *
   * A close that gave up on a start that never unwound cannot release the
   * provider, and that provider may still be running. The retained cleanup
   * keeps the start permit until it succeeds, so the analysis cap keeps
   * counting the provider that is still alive.
   */
  readonly retainedPermits: Set<StartPermit>;
}

type AnalysisJobState = "starting" | "ready" | "failed" | "cancelled";

/**
 * The answer of a close, and what it says about the provider cleanup.
 *
 * A close can fail after the provider was released: a snapshot close of a
 * wedged start reports that no snapshot was taken, but the provider it
 * released is gone. The registry retires a slot on the cleanup fact and
 * reports the answer as it is, so a closed slot is never listed as retained.
 */
interface CloseOutcome<Value> {
  /** The answer the caller receives. */
  readonly answer: Result<Value, AnalysisError>;
  /** True when the provider was released, whatever the answer says. */
  readonly released: boolean;
}

type OpenOptions = NonNullable<Parameters<BinarySessionPort["open"]>[1]>;
type OpenResolvedOptions = NonNullable<
  Parameters<BinarySessionPort["openResolvedTarget"]>[1]
>;

interface AnalysisJob {
  readonly slot: TargetSlot;
  readonly target: BinaryTarget;
  readonly controller: AbortController;
  readonly startedAt: number;
  readonly mode: "background" | "auto";
  state: AnalysisJobState;
  error: AnalysisError | undefined;
  /** Completion time of a terminal job; undefined while the job is starting. */
  finishedAt: number | undefined;
  promise: Promise<void>;
  /**
   * The cancellation of this job, shared by every request that cancels it.
   *
   * The cancellation belongs to the job, so two requests that cancel the same
   * job wait for the same operation: the slot is force-closed once and the
   * job leaves the slot once. A cancellation that failed is given up, so a
   * later request retries the cleanup instead of replaying the failure.
   */
  cancellation: Promise<Result<null, AnalysisError>> | undefined;
}

/**
 * The analysis a slot answers for.
 *
 * A slot answers for the job that is bound to it, or for the target its
 * session holds when no job is bound to it. The observation names the job
 * and the provider the slot is bound to, so a decision that was made against
 * the slot can be checked against it again after an await.
 */
interface SlotAnswer {
  /** The job that binds the slot, when one binds it. */
  readonly job: AnalysisJob | undefined;
  /** The provider the slot is bound to. */
  readonly providerId: string;
}

/**
 * The answer of an open: the slot that holds the target and the target it
 * holds.
 *
 * The handle and the analysis state belong to the slot, and the target is
 * the one the open produced, so the answer keeps them together. A later open
 * that replaces the slot does not change the answer.
 */
interface OpenAnswer {
  readonly slot: TargetSlot;
  readonly target: BinaryTarget;
}

/**
 * One shared start permit.
 *
 * A permit is taken around a provider start and given back when the start
 * settles. A start that never settles keeps its permit until the close that
 * gave up on it releases it, so a later start is never queued behind a start
 * that will never finish. A close that could not release the provider keeps
 * the permit: the provider may still be running, so the analysis cap has to
 * count it. The retained cleanup gives the permit back when it succeeds.
 *
 * The permit is never held across a wait that another request needs it for:
 * an open that waits for the calls that ran before it may be one of the
 * requests that waits for a permit, so holding the permit there would let
 * two requests wait for each other forever.
 */
interface StartPermit {
  held: boolean;
  /** True once a retained cleanup owns this permit instead of its start. */
  retained: boolean;
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
  /**
   * The reader every slot uses for app resource roots.
   *
   * A resource-only app session belongs to a slot like any other target, so
   * the factory is shared by the slots the registry creates.
   */
  readonly #bundleResourceFactory: BundleResourceClientFactory | undefined;
  readonly #slots = new Map<string, TargetSlot>();
  readonly #jobs = new Map<string, AnalysisJob>();
  /** Slot handles whose provider cleanup failed and still owns its resource. */
  readonly #retainedSlots = new Set<string>();
  /** Slot handles reserved by an open that has not produced its target yet. */
  readonly #reservedSlots = new Set<string>();
  readonly #availabilityListeners = new Set<() => void | Promise<void>>();
  readonly #snapshotListeners = new Set<() => void | Promise<void>>();
  /**
   * The slot every Evidence write of the request in flight belongs to.
   *
   * A request is admitted for one slot, and its provider calls run against
   * that slot. Another open may make another slot current while the request
   * runs, so the slot the request was admitted for is carried with it and
   * owns the Evidence it records.
   */
  readonly #admittedSlots = new AsyncLocalStorage<TargetSlot>();
  #primary: TargetSlot;
  #currentId: string;
  #activeStarts = 0;
  readonly #startQueue: Array<() => void> = [];
  /** The retained cleanup retry that is in flight. */
  #retainedCleanupRetry: Promise<void> | undefined;

  constructor(
    router: SessionProviderRouter,
    records: InvestigationRecords = new InvestigationRecords(),
    limits: Partial<BinaryTargetLimits> = {},
    bundleResourceFactory?: BundleResourceClientFactory,
  ) {
    this.#router = router;
    this.#records = records;
    this.#bundleResourceFactory = bundleResourceFactory;
    this.#limits = {
      maxOpenTargets: Math.max(
        1,
        limits.maxOpenTargets ?? DEFAULT_LIMITS.maxOpenTargets,
      ),
      maxConcurrentAnalyses: Math.max(
        1,
        limits.maxConcurrentAnalyses ?? DEFAULT_LIMITS.maxConcurrentAnalyses,
      ),
      autoBackgroundAfterMs: Math.max(
        1,
        limits.autoBackgroundAfterMs ?? DEFAULT_LIMITS.autoBackgroundAfterMs,
      ),
      jobSettleTimeoutMs: Math.max(
        1,
        limits.jobSettleTimeoutMs ?? DEFAULT_LIMITS.jobSettleTimeoutMs,
      ),
    };
    this.#primary = this.#createSlot();
    this.#currentId = this.#primary.id;
  }

  /** Currently open target handles in deterministic creation order. */
  targets(): readonly {
    readonly target_id: string;
    readonly target: BinaryTarget;
  }[] {
    return [...this.#slots.values()].flatMap((slot) => {
      const target =
        slot.session.activeTarget() ?? this.#jobs.get(slot.id)?.target;
      return target === undefined ? [] : [{ target_id: slot.id, target }];
    });
  }

  /** Identifier of the target addressed when a call omits target_id. */
  currentTargetId(): string | undefined {
    return this.#targetForSlot(this.#slotById(this.#currentId)) === undefined
      ? undefined
      : this.#currentId;
  }

  /** Current background-analysis state for one target, when tracked. */
  analysisState(targetId?: string): JsonValue | undefined {
    const slot = this.#resolveSlotResult(targetId);
    if (!slot.ok) return undefined;
    const job = this.#jobForSlot(slot.value);
    if (job === undefined) return undefined;
    return {
      state: job.state,
      mode: job.mode,
      started_at: new Date(job.startedAt).toISOString(),
      elapsed_ms: this.#jobElapsedMs(job),
      ...(job.error === undefined
        ? {}
        : {
            error: {
              code: projectAnalysisError(job.error).code,
              message: job.error.message,
            },
          }),
    };
  }

  /** Elapsed time of a job; a finished job stops counting at its completion. */
  #jobElapsedMs(job: AnalysisJob): number {
    return (job.finishedAt ?? Date.now()) - job.startedAt;
  }

  async open(
    path: string,
    options: Parameters<BinarySessionPort["open"]>[1] = {},
  ): Promise<Result<OpenedTarget, AnalysisError>> {
    const opened = await this.#openTarget(path, options);
    return opened.ok ? ok(this.#openedTarget(opened.value)) : opened;
  }

  async openResolvedTarget(
    resolved: Pick<ResolvedSessionOpen, "target" | "route">,
    options: Parameters<BinarySessionPort["openResolvedTarget"]>[1] = {},
  ): Promise<Result<OpenedTarget, AnalysisError>> {
    const opened = await this.#openResolved(resolved, options);
    return opened.ok ? ok(this.#openedTarget(opened.value)) : opened;
  }

  /**
   * The handle and the analysis state of the target an open produced.
   *
   * The handle names the slot that holds the target and the state belongs to
   * that slot, so the reply describes the target the open produced. Reading
   * the current target after the open can name a different target when
   * another open replaced it in the meantime.
   */
  #openedTarget(answer: OpenAnswer): OpenedTarget {
    const analysis = this.analysisState(answer.slot.id);
    return {
      target: answer.target,
      target_id: answer.slot.id,
      ...(analysis === undefined ? {} : { analysis }),
    };
  }

  async #openTarget(
    path: string,
    options: OpenOptions,
  ): Promise<Result<OpenAnswer, AnalysisError>> {
    if ((options.analysisMode ?? "foreground") !== "foreground")
      return this.#openAsJob(path, options);
    if (options.keepOthersOpen !== true)
      return this.#openReplacing(path, options);
    const existing = this.#slotForPath(path);
    if (existing !== undefined)
      return this.#openInSlot(existing, path, options);
    return this.#openInNewSlot(path, options);
  }

  async #openResolved(
    resolved: Pick<ResolvedSessionOpen, "target" | "route">,
    options: OpenResolvedOptions,
  ): Promise<Result<OpenAnswer, AnalysisError>> {
    if ((options.analysisMode ?? "foreground") !== "foreground")
      return this.#openResolvedAsJob(resolved, options);
    if (options.keepOthersOpen !== true)
      return this.#openResolvedReplacing(resolved, options);
    const existing = this.#slotForPath(resolved.target.path);
    if (existing !== undefined)
      return this.#openResolvedInSlot(existing, resolved, options);
    return this.#openResolvedInNewSlot(resolved, options);
  }

  async #openReplacing(
    path: string,
    options: OpenOptions,
  ): Promise<Result<OpenAnswer, AnalysisError>> {
    const cancelled = await this.#cancelJobAndWait(this.#primary);
    if (!cancelled.ok) return cancelled;
    const closed = await this.#closeSlotsExcept(this.#primary);
    if (!closed.ok) return closed;
    return this.#openInSlot(this.#primary, path, options);
  }

  async #openResolvedReplacing(
    resolved: Pick<ResolvedSessionOpen, "target" | "route">,
    options: OpenResolvedOptions,
  ): Promise<Result<OpenAnswer, AnalysisError>> {
    const cancelled = await this.#cancelJobAndWait(this.#primary);
    if (!cancelled.ok) return cancelled;
    const closed = await this.#closeSlotsExcept(this.#primary);
    if (!closed.ok) return closed;
    return this.#openResolvedInSlot(this.#primary, resolved, options);
  }

  async #openAsJob(
    path: string,
    options: OpenOptions,
  ): Promise<Result<OpenAnswer, AnalysisError>> {
    if (isAborted(options.signal))
      return err(new AnalysisCancelledError("open_binary"));
    const parsed = await parseBinaryTarget(path, {
      ...(options.targetKind === undefined
        ? {}
        : { targetKind: options.targetKind }),
      ...(options.formatHint === undefined
        ? {}
        : { formatHint: options.formatHint }),
      ...(options.architecture === undefined
        ? {}
        : { architecture: options.architecture }),
      ...(options.entryPoint === undefined
        ? {}
        : { entryPoint: options.entryPoint }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!parsed.ok) return parsed;
    const existing = this.#slotForPath(path);
    const reusable =
      existing === undefined
        ? undefined
        : this.#reusableSlot(existing, parsed.value, options);
    if (reusable !== undefined) {
      const reused = await this.#answerForReusedSlot(
        reusable,
        parsed.value,
        options,
      );
      if (reused !== undefined) return reused;
    }
    const slot = await this.#slotForJob(options);
    if (!slot.ok) return slot;
    // The target is parsed once here; the slot opens the resolved target so
    // the provider start never repeats the parse.
    const preview = await slot.value.session.previewTarget(parsed.value, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.providerId === undefined
        ? {}
        : { providerId: options.providerId }),
    });
    if (!preview.ok) {
      // The new target never became usable, so the slot it would have used is
      // dropped. The primary is never dropped here: it may already own a live
      // open target, and unregistering it would make that target invisible
      // and unclosable.
      if (slot.value !== this.#primary) this.#removeSlot(slot.value, "primary");
      return preview;
    }
    return this.#startJob(
      slot.value,
      parsed.value,
      "background",
      (signal) =>
        slot.value.session.openResolvedTarget(preview.value, {
          ...options,
          signal,
          // The job reports the target as started, so the provider it
          // selected starts inside this job's window, under its start limit.
          startProvider: true,
          // A provider the client still defers starts under the admission, so
          // the shared start limit covers that start as well.
          startAdmission: this.#startAdmission(slot.value),
        }),
      options,
    );
  }

  async #openResolvedAsJob(
    resolved: Pick<ResolvedSessionOpen, "target" | "route">,
    options: OpenResolvedOptions,
  ): Promise<Result<OpenAnswer, AnalysisError>> {
    if (isAborted(options.signal))
      return err(new AnalysisCancelledError("open_binary"));
    const existing = this.#slotForPath(resolved.target.path);
    const reusable =
      existing === undefined
        ? undefined
        : this.#reusableSlot(existing, resolved.target, options);
    if (reusable !== undefined) {
      const reused = await this.#answerForReusedSlot(
        reusable,
        resolved.target,
        options,
      );
      if (reused !== undefined) return reused;
    }
    const slot = await this.#slotForJob(options);
    if (!slot.ok) return slot;
    return this.#startJob(
      slot.value,
      resolved.target,
      "background",
      (signal) =>
        slot.value.session.openResolvedTarget(resolved, {
          ...options,
          signal,
          // The job reports the target as started, so the provider it
          // selected starts inside this job's window, under its start limit.
          startProvider: true,
          // A provider the client still defers starts under the admission, so
          // the shared start limit covers that start as well.
          startAdmission: this.#startAdmission(slot.value),
        }),
      options,
    );
  }

  /**
   * The slot whose live target a background open may reuse.
   *
   * A reuse keeps the open target and its analysis only when the request
   * asks for that same target. A rebuilt binary at the same path is a
   * different target, an explicit provider switch changes the binding, and a
   * staged snapshot has to be imported, so none of them reuse the previous
   * open. A request that replaces the current target only reuses the primary
   * slot, because the replace path owns every other slot.
   */
  #reusableSlot(
    slot: TargetSlot,
    requested: BinaryTarget,
    options: OpenOptions,
  ): TargetSlot | undefined {
    if (options.keepOthersOpen !== true && slot !== this.#primary)
      return undefined;
    if (options.providerId !== undefined) return undefined;
    if (options.snapshot !== undefined || options.loadSnapshot !== undefined)
      return undefined;
    const live = slot.session.activeTarget() ?? this.#jobs.get(slot.id)?.target;
    if (live === undefined) return undefined;
    return sameSessionTarget(live, requested) ? slot : undefined;
  }

  /**
   * Answer for a background open that reuses an open target.
   *
   * A reused target answers for the slot that holds it, but the request
   * still replaces the other targets, so they are closed here: the replace
   * path that closes them is skipped by the reuse. The primary keeps the
   * target and the job the reuse answers for; only the other slots are
   * closed.
   *
   * The close is an await, and the slot may take on another analysis while
   * it waits: a rebuilt binary at the same path, a job that took the slot
   * over, or another provider bound to it. The reuse is therefore checked
   * against the slot again before the answer, and a slot that took on
   * another analysis answers with nothing, so the request opens the target
   * it asked for instead of answering for the replacement.
   */
  async #answerForReusedSlot(
    slot: TargetSlot,
    requested: BinaryTarget,
    options: OpenOptions,
  ): Promise<Result<OpenAnswer, AnalysisError> | undefined> {
    const answer = this.#slotAnswer(slot);
    const closed = await this.#closeReplacedSlots(options);
    if (!closed.ok) return closed;
    if (!this.#stillAnswersFor(slot, answer, requested)) return undefined;
    const job = this.#blockingJob(slot);
    if (job !== undefined) {
      // The reused job answers for its own slot, so that slot becomes the
      // current one. Otherwise the caller reads the handle and the analysis
      // state of a different target.
      this.#currentId = slot.id;
      return this.#jobOpenResult(job, options).then((opened) =>
        opened.ok ? ok({ slot, target: opened.value }) : opened,
      );
    }
    const active = slot.session.activeTarget();
    if (active === undefined) return undefined;
    this.#currentId = slot.id;
    return ok({ slot, target: active });
  }

  /**
   * The analysis a slot answers for.
   *
   * The observation is taken with the decision that may reuse the slot, so
   * the decision can be checked against the slot again after the await that
   * follows it.
   */
  #slotAnswer(slot: TargetSlot): SlotAnswer {
    return {
      job: this.#boundJob(slot),
      providerId: slot.session.providerIdentity().id,
    };
  }

  /**
   * Whether a slot still answers for the analysis a decision was made on.
   *
   * The decision was made before an await, so the slot may have taken on
   * another analysis in the meantime. Another job binds the slot, the slot
   * answers for another target, or the slot is bound to another provider,
   * and a reuse that answered for that analysis would give the caller the
   * handle and the analysis of a target the request never asked for.
   */
  #stillAnswersFor(
    slot: TargetSlot,
    answer: SlotAnswer,
    requested: BinaryTarget,
  ): boolean {
    const job = this.#boundJob(slot);
    if (job !== answer.job) return false;
    const target = slot.session.activeTarget() ?? job?.target;
    if (target === undefined) return false;
    if (!sameSessionTarget(target, requested)) return false;
    // A job owns the provider it started, so only a slot that no job binds
    // is compared with the provider it was bound to.
    if (
      job === undefined &&
      slot.session.providerIdentity().id !== answer.providerId
    )
      return false;
    return true;
  }

  /**
   * Close the targets a request that replaces them leaves open.
   *
   * A background open that reuses the target the primary already holds skips
   * the replace path, so the other targets would stay open although the
   * request asked to replace them. The primary keeps the target and the job
   * the reuse answers for; only the other slots are closed.
   */
  async #closeReplacedSlots(
    options: OpenOptions,
  ): Promise<Result<null, AnalysisError>> {
    if (options.keepOthersOpen === true) return ok(null);
    return this.#closeSlotsExcept(this.#primary);
  }

  async #slotForJob(
    options: OpenOptions,
  ): Promise<Result<TargetSlot, AnalysisError>> {
    if (options.keepOthersOpen === true) {
      // The slot is reserved before the open waits for anything, so two
      // overlapping opens cannot both pass the capacity check.
      return this.#reserveSlot("open_binary");
    }
    const closed = await this.#closeSlotsExcept(this.#primary);
    if (!closed.ok) return closed;
    const cancelled = await this.#cancelJobAndWait(this.#primary);
    if (!cancelled.ok) return cancelled;
    return ok(this.#primary);
  }

  /**
   * Reserve one slot for an open that has not produced its target yet.
   *
   * The reservation is counted against the open capacity before the open
   * waits, so overlapping opens cannot both see room for a target they are
   * about to create.
   */
  #reserveSlot(operation: string): Result<TargetSlot, AnalysisError> {
    const capacity = this.#checkOpenCapacity(operation);
    if (capacity !== undefined) return capacity;
    const slot = this.#createSlot();
    this.#reservedSlots.add(slot.id);
    return ok(slot);
  }

  /** Give back the capacity a reserved slot was holding. */
  #releaseReservation(slot: TargetSlot): void {
    this.#reservedSlots.delete(slot.id);
  }

  /**
   * Give a replaced target its own handle.
   *
   * A handle names one live target. When the slot takes on a different
   * target, the handle changes with it, so a handle that named the previous
   * target never selects the replacement.
   */
  #syncHandle(slot: TargetSlot, target: BinaryTarget): void {
    const previous = slot.handleTarget;
    slot.handleTarget = target;
    if (previous === undefined) return;
    if (sameSessionTarget(previous, target)) return;
    this.#mintHandle(slot);
  }

  /** Move a slot to a fresh handle without changing the target it holds. */
  #mintHandle(slot: TargetSlot): void {
    const previousId = slot.id;
    const nextId = randomUUID();
    slot.id = nextId;
    this.#rekey(this.#slots, previousId, nextId);
    this.#rekey(this.#jobs, previousId, nextId);
    if (this.#retainedSlots.delete(previousId)) this.#retainedSlots.add(nextId);
    if (this.#reservedSlots.delete(previousId)) this.#reservedSlots.add(nextId);
    if (this.#currentId === previousId) this.#currentId = nextId;
  }

  /** Rename one map key in place, keeping the order of the other keys. */
  #rekey<Value>(
    entries: Map<string, Value>,
    previousId: string,
    nextId: string,
  ): void {
    if (!entries.has(previousId)) return;
    const renamed = new Map<string, Value>();
    for (const [id, value] of entries)
      renamed.set(id === previousId ? nextId : id, value);
    entries.clear();
    for (const [id, value] of renamed) entries.set(id, value);
  }

  #startJob(
    slot: TargetSlot,
    target: BinaryTarget,
    requestedMode: "background" | "auto",
    start: (
      signal: AbortSignal,
    ) => Promise<Result<OpenedTarget, AnalysisError>>,
    options: OpenOptions,
  ): Promise<Result<OpenAnswer, AnalysisError>> {
    const mode =
      options.analysisMode === "auto" ? ("auto" as const) : requestedMode;
    const controller = new AbortController();
    const startedAt = Date.now();
    const job: AnalysisJob = {
      slot,
      target,
      controller,
      startedAt,
      mode,
      state: "starting",
      error: undefined,
      finishedAt: undefined,
      promise: Promise.resolve(),
      cancellation: undefined,
    };
    this.#releaseReservation(slot);
    this.#syncHandle(slot, target);
    this.#slots.set(slot.id, slot);
    this.#jobs.set(slot.id, job);
    this.#currentId = slot.id;
    job.promise = this.#runJob(job, start);
    if (mode === "background") return Promise.resolve(ok({ slot, target }));
    const threshold = Math.max(
      1,
      options.autoBackgroundAfterMs ?? this.#limits.autoBackgroundAfterMs,
    );
    return this.#waitForAutoJob(job, threshold, options.signal)
      .then((outcome) => this.#jobOutcome(job, outcome))
      .then((opened) =>
        opened.ok ? ok({ slot, target: opened.value }) : opened,
      );
  }

  /**
   * Run one job and let the session start its provider under the limit.
   *
   * The permit bounds simultaneous provider starts for background jobs exactly
   * as it does for foreground opens, and the queue is FIFO. The job owns the
   * start signal, so cancelling a queued start through `close_binary` releases
   * the queue entry without ever consuming a permit.
   *
   * The permit is taken around the provider start the session runs, not
   * around the whole open: the open waits for the calls that ran before it,
   * and one of those calls may be the request that waits for the permit.
   */
  async #runJob(
    job: AnalysisJob,
    start: (
      signal: AbortSignal,
    ) => Promise<Result<OpenedTarget, AnalysisError>>,
  ): Promise<void> {
    try {
      const result = await start(job.controller.signal);
      if (job.controller.signal.aborted) {
        this.#finishJob(
          job,
          "cancelled",
          result.ok ? new AnalysisCancelledError("open_binary") : result.error,
        );
        return;
      }
      if (result.ok) {
        this.#finishJob(job, "ready");
        return;
      }
      this.#finishJob(job, "failed", result.error);
    } catch (cause: unknown) {
      this.#finishJob(
        job,
        job.controller.signal.aborted ? "cancelled" : "failed",
        cause instanceof AnalysisError
          ? cause
          : new AnalysisCancelledError("open_binary"),
      );
    }
  }

  /** Record a terminal job state and stop its elapsed clock. */
  #finishJob(
    job: AnalysisJob,
    state: AnalysisJobState,
    error?: AnalysisError,
  ): void {
    job.state = state;
    job.error = error;
    job.finishedAt = Date.now();
    if (state === "ready") return;
    // A failed start that could not release its provider leaves the slot
    // owning a resource, so the slot is reported as retained and the
    // retained cleanup keeps the start permit.
    if (job.slot.retainedPermits.size > 0) this.#retainedSlots.add(job.slot.id);
    this.#separateRestoredTarget(job);
  }

  /**
   * Keep a restored target apart from the job that did not become ready.
   *
   * A failed open restores the target the session held before, so the slot
   * holds a live target that the job never opened. The handle the job was
   * minted for names the target that never opened, so it must not select the
   * restored one: the restored target receives its own handle, and the failed
   * job's handle is retired with it.
   */
  #separateRestoredTarget(job: AnalysisJob): void {
    const slot = job.slot;
    const live = slot.session.activeTarget();
    if (live === undefined) return;
    if (sameSessionTarget(live, job.target)) return;
    this.#syncHandle(slot, live);
  }

  async #waitForAutoJob(
    job: AnalysisJob,
    thresholdMs: number,
    signal: AbortSignal | undefined,
  ): Promise<"ready" | "failed" | "aborted" | "timeout"> {
    if (isAborted(signal)) return "aborted";
    const outcome = await new Promise<
      "ready" | "failed" | "aborted" | "timeout"
    >((resolve) => {
      let settled = false;
      const finish = (
        value: "ready" | "failed" | "aborted" | "timeout",
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const timer = setTimeout(() => finish("timeout"), thresholdMs);
      timer.unref?.();
      const onAbort = (): void => finish("aborted");
      signal?.addEventListener("abort", onAbort, { once: true });
      void job.promise.then(() =>
        finish(job.state === "ready" ? "ready" : "failed"),
      );
    });
    return outcome;
  }

  /**
   * One rule for the answer a job gives.
   *
   * An aborted wait means the request was cancelled while the job kept
   * running, so the request reports cancellation. A timed-out wait means the
   * job is still starting, so the request reports the started target. The
   * first open and a re-open of the same running job share this rule.
   */
  #jobOutcome(
    job: AnalysisJob,
    outcome: "ready" | "failed" | "aborted" | "timeout",
  ): Result<BinaryTarget, AnalysisError> {
    if (outcome === "ready") return ok(job.target);
    if (outcome === "failed") return this.#terminalJobOutcome(job);
    if (outcome === "aborted")
      return err(new AnalysisCancelledError("open_binary"));
    return ok(job.target);
  }

  /** Report a job that reached a terminal state without becoming ready. */
  #terminalJobOutcome(job: AnalysisJob): Result<BinaryTarget, AnalysisError> {
    if (job.state === "failed")
      return err(job.error ?? new AnalysisCancelledError("open_binary"));
    return err(new AnalysisCancelledError("open_binary"));
  }

  #jobOpenResult(
    job: AnalysisJob,
    options: OpenOptions,
  ): Promise<Result<BinaryTarget, AnalysisError>> {
    if (job.state === "ready") return Promise.resolve(ok(job.target));
    if (job.state === "starting" && job.mode === "background")
      return Promise.resolve(ok(job.target));
    if (job.state === "failed" || job.state === "cancelled")
      return Promise.resolve(this.#terminalJobOutcome(job));
    return this.#waitForAutoJob(
      job,
      Math.max(
        1,
        options.autoBackgroundAfterMs ?? this.#limits.autoBackgroundAfterMs,
      ),
      options.signal,
    ).then((outcome) => this.#jobOutcome(job, outcome));
  }

  async #openInNewSlot(
    path: string,
    options: OpenOptions,
  ): Promise<Result<OpenAnswer, AnalysisError>> {
    // The slot is reserved before the open waits, so two overlapping opens
    // cannot both pass the capacity check.
    const reserved = this.#reserveSlot("open_binary");
    if (!reserved.ok) return reserved;
    return this.#openInSlot(reserved.value, path, options);
  }

  async #openResolvedInNewSlot(
    resolved: Pick<ResolvedSessionOpen, "target" | "route">,
    options: OpenResolvedOptions,
  ): Promise<Result<OpenAnswer, AnalysisError>> {
    const reserved = this.#reserveSlot("open_binary");
    if (!reserved.ok) return reserved;
    return this.#openResolvedInSlot(reserved.value, resolved, options);
  }

  async #openInSlot(
    slot: TargetSlot,
    path: string,
    options: OpenOptions,
  ): Promise<Result<OpenAnswer, AnalysisError>> {
    const job = this.#blockingJob(slot);
    if (job !== undefined) {
      await job.promise;
      return job.state === "ready"
        ? ok({ slot, target: job.target })
        : err(job.error ?? new AnalysisCancelledError("open_binary"));
    }
    const opened = await slot.session.open(path, {
      ...options,
      // The client starts the provider it defers under this admission, so
      // the shared start limit covers that start too.
      startAdmission: this.#startAdmission(slot),
    });
    return this.#finishOpen(slot, opened);
  }

  async #openResolvedInSlot(
    slot: TargetSlot,
    resolved: Pick<ResolvedSessionOpen, "target" | "route">,
    options: OpenResolvedOptions,
  ): Promise<Result<OpenAnswer, AnalysisError>> {
    const job = this.#blockingJob(slot);
    if (job !== undefined) {
      await job.promise;
      return job.state === "ready"
        ? ok({ slot, target: job.target })
        : err(job.error ?? new AnalysisCancelledError("open_binary"));
    }
    const opened = await slot.session.openResolvedTarget(resolved, {
      ...options,
      // The client starts the provider it defers under this admission, so
      // the shared start limit covers that start too.
      startAdmission: this.#startAdmission(slot),
    });
    return this.#finishOpen(slot, opened);
  }

  /**
   * The admission that bounds a provider start.
   *
   * A composed client starts the provider it defers with the first call that
   * needs it, and an open starts the provider it selected, so both run under
   * this admission: the shared start limit covers the real starts and not
   * only the opens that resolved a target. The permit is taken around the
   * start and given back when the start settles, so a start that never
   * begins holds nothing.
   *
   * The permit is taken after the calls that ran before the start have
   * drained. An open that holds a permit while it waits for those calls
   * would wait for a request that waits for that same permit, and the two
   * would wait for each other forever.
   *
   * A failed start leaves a provider behind, and the cleanup of that failed
   * start runs under the same permit: the permit counts the provider while
   * it may still be running. A cleanup that could not release the provider
   * hands the permit to the retained cleanup, which gives it back when the
   * provider is gone.
   *
   * A start the admission could not attempt, because the permit could not be
   * acquired, runs the cleanup as well: the open still owns a client it
   * created and a target it replaced, and the cleanup is what releases them.
   * No provider was started under that permit, so a provider the cleanup
   * could not release is counted by a permit of its own.
   *
   * The permit belongs to the slot that runs the start: a close that gave up
   * on a start that never unwound gives it back, and a close that could not
   * release the provider keeps it.
   */
  #startAdmission(slot: TargetSlot): ProviderStartAdmission {
    return {
      run: async (start, operation, signal, cleanup) => {
        const permit: StartPermit = { held: false, retained: false };
        const acquired = await this.#acquireStartPermit(
          operation,
          signal,
          permit,
        );
        if (!acquired.ok) {
          // The start never ran, so no provider was started under this
          // permit. The cleanup of the failed open still owns the client the
          // open created and the target it replaced, so it runs here.
          if (cleanup === undefined) return err(acquired.error);
          const failed = await cleanup(acquired.error);
          if (failed.providerAlive) {
            // The provider may still be running, so the retained cleanup
            // owns a permit of its own and gives it back when the provider
            // is gone.
            this.#retainProviderPermit(slot);
          }
          return err(failed.error);
        }
        slot.startPermits.add(permit);
        try {
          const started = await start();
          if (started.ok || cleanup === undefined) return started;
          // The failed start left a provider behind. Its cleanup runs under
          // this permit, so the permit counts that provider until the
          // cleanup settles.
          const failed = await cleanup(started.error);
          if (failed.providerAlive) {
            // The provider may still be running, so the retained cleanup
            // owns the permit and gives it back when the provider is gone.
            permit.retained = true;
            slot.retainedPermits.add(permit);
          }
          return err(failed.error);
        } finally {
          slot.startPermits.delete(permit);
          // A retained cleanup owns the permit when the provider it started
          // may still be running, and only that cleanup may give it back.
          if (!permit.retained) this.#releaseStartPermit(permit);
        }
      },
    };
  }

  #finishOpen(
    slot: TargetSlot,
    opened: Result<OpenedTarget, AnalysisError>,
  ): Result<OpenAnswer, AnalysisError> {
    if (!opened.ok) {
      this.#releaseReservation(slot);
      if (slot.retainedPermits.size > 0) {
        // The failed start left a provider that could not be released, so it
        // may still be running. The slot keeps its registration and the
        // retained resource it still owns, so the retained cleanup can
        // release that provider and a later close can retry the cleanup.
        this.#slots.set(slot.id, slot);
        this.#retainedSlots.add(slot.id);
        this.#jobs.delete(slot.id);
      } else if (
        slot !== this.#primary &&
        slot.session.activeTarget() === undefined
      )
        this.#removeSlot(slot, "primary");
      return opened;
    }
    this.#releaseReservation(slot);
    this.#syncHandle(slot, opened.value.target);
    this.#slots.set(slot.id, slot);
    this.#currentId = slot.id;
    return ok({ slot, target: opened.value.target });
  }

  previewTarget(
    target: BinaryTarget,
    options: Parameters<BinarySessionPort["previewTarget"]>[1] = {},
  ): Promise<Result<ResolvedSessionOpen, AnalysisError>> {
    return this.#currentSlot().session.previewTarget(target, options);
  }

  /**
   * Open a resource-only app root in the current slot.
   *
   * A resource-only session has no executable target, so it is addressed by
   * the slot that owns the current target rather than by a target handle.
   */
  openBundleResources(
    path: string,
    options: Pick<ExecutionOptions, "signal"> = {},
  ): Promise<Result<ResolvedAppBundleResourceRoot, AnalysisError>> {
    return this.#currentSlot().session.openBundleResources(path, options);
  }

  close(
    options: Parameters<BinarySessionPort["close"]>[0] = {},
  ): Promise<Result<null, AnalysisError>> {
    return this.#closeSlotFor(
      options,
      async (slot, behavior) => {
        const closed = await slot.session.closeAsSlot(options, behavior);
        return { answer: closed, released: closed.ok };
      },
      async (slot, behavior) => {
        const closed = await this.#closeSlotWithoutTransition(
          slot,
          options,
          behavior,
        );
        return { answer: closed, released: closed.ok };
      },
    );
  }

  /**
   * Close every slot; incomplete cleanup stays visible on the first failure.
   *
   * A slot whose close failed keeps its registration, its job entry, and the
   * retained resource it still owns, so a later close can retry the cleanup.
   * Only a successful close retires a slot.
   */
  async closeAll(
    options: Parameters<NonNullable<BinarySessionPort["closeAll"]>>[0] = {},
  ): Promise<Result<null, AnalysisError>> {
    let failure: AnalysisError | undefined;
    for (const slot of [...this.#slots.values()]) {
      if (slot === this.#primary) continue;
      const closed = await this.#closeSlot(slot, options, {
        clearRecords: false,
        closeOwnedProviderResources: false,
      });
      if (!closed.ok) {
        failure ??= closed.error;
        this.#retainedSlots.add(slot.id);
        this.#jobs.delete(slot.id);
        continue;
      }
      this.#retireClosedSlot(slot);
    }
    const final = await this.#closeSlot(this.#primary, options, {
      clearRecords: true,
      closeOwnedProviderResources: true,
    });
    if (!final.ok) {
      failure ??= final.error;
      this.#retainedSlots.add(this.#primary.id);
      this.#jobs.delete(this.#primary.id);
    } else {
      this.#retireClosedSlot(this.#primary);
    }
    return failure === undefined ? ok(null) : err(failure);
  }

  /**
   * Abort a slot's job, wait for it to unwind, and close the slot session.
   *
   * The wait is bounded. A provider start that ignores its abort keeps the
   * session's transition promise unsettled, and the ordinary close serializes
   * behind that promise, so waiting for it forever would hang the close and
   * the server shutdown with it. When the bound expires the close escalates
   * to the path that releases the pending client without the transition
   * chain; the cleanup still runs through the owner that stops the provider.
   */
  async #closeSlot(
    slot: TargetSlot,
    options: Pick<ExecutionOptions, "progress"> & {
      readonly retainProviderDocuments?: boolean;
      readonly targetId?: string;
    },
    behavior: {
      readonly clearRecords: boolean;
      readonly closeOwnedProviderResources: boolean;
    },
  ): Promise<Result<null, AnalysisError>> {
    const settled = await this.#abortJobAndWait(slot);
    if (settled) return slot.session.closeAsSlot(options, behavior);
    return this.#closeSlotWithoutTransition(slot, options, behavior);
  }

  /** Retire a slot whose provider start did not unwind in time. */
  async #closeSlotWithoutTransition(
    slot: TargetSlot,
    options: Pick<ExecutionOptions, "progress"> & {
      readonly retainProviderDocuments?: boolean;
      readonly targetId?: string;
    },
    behavior: {
      readonly clearRecords: boolean;
      readonly closeOwnedProviderResources: boolean;
    },
  ): Promise<Result<null, AnalysisError>> {
    const escalate = slot.session.closeWithoutTransition;
    const closed =
      escalate === undefined
        ? await slot.session.closeAsSlot(options, behavior)
        : await escalate.call(slot.session, options, behavior);
    if (!closed.ok) {
      // The provider could not be released, so it may still be running. The
      // retained cleanup keeps the start permit: the analysis cap has to
      // count that provider until the cleanup succeeds.
      this.#retainSlotPermits(slot);
      return closed;
    }
    // The start that never unwound still holds the shared start permit. The
    // close gives it back, so a later open is not queued behind a start that
    // will never finish.
    this.#releaseSlotPermits(slot);
    return closed;
  }

  closeWithSnapshot(
    path: string,
    overwrite: boolean,
    options: Parameters<BinarySessionPort["closeWithSnapshot"]>[2] = {},
  ): Promise<Result<SavedAnalysisSnapshot, AnalysisError>> {
    return this.#closeSlotFor(
      options,
      async (slot, behavior) => {
        const closed = await slot.session.closeWithSnapshotAsSlot(
          path,
          overwrite,
          options,
          behavior,
        );
        return { answer: closed, released: closed.ok };
      },
      // A wedged start cannot be snapshotted, but the provider still has to be
      // released. The escalation closes the slot the same way the plain close
      // does, and the snapshot is reported as not taken. The provider was
      // released either way, so the slot is retired instead of retained.
      async (slot, behavior) => {
        const closed = await this.#closeSlotWithoutTransition(
          slot,
          options,
          behavior,
        );
        return {
          answer: closed.ok
            ? err(
                new AnalysisCancelledError("close_binary", {
                  diagnostics: {
                    reason:
                      "the provider start did not unwind within the settle bound, so no analysis snapshot was taken",
                    settle_bound_ms: this.#limits.jobSettleTimeoutMs,
                  },
                }),
              )
            : closed,
          released: closed.ok,
        };
      },
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
    ) => Promise<CloseOutcome<Value>>,
    escalate: (
      slot: TargetSlot,
      behavior: {
        readonly clearRecords: boolean;
        readonly closeOwnedProviderResources: boolean;
      },
    ) => Promise<CloseOutcome<Value>>,
  ): Promise<Result<Value, AnalysisError>> {
    const slot = this.#resolveCloseSlot(options.targetId);
    if (!slot.ok) return slot;
    const last = this.#openSlotCount() <= 1;
    const settled = await this.#abortJobAndWait(slot.value);
    const outcome = await (settled
      ? close(slot.value, {
          clearRecords: last,
          closeOwnedProviderResources: last,
        })
      : escalate(slot.value, {
          clearRecords: last,
          closeOwnedProviderResources: last,
        }));
    if (outcome.released) {
      this.#retireClosedSlot(slot.value);
    } else {
      // The slot keeps its registration and its retained resource, so a later
      // close can retry the cleanup. It is no longer an open target: the
      // closed target must not stay listed or routable.
      this.#retainedSlots.add(slot.value.id);
      this.#jobs.delete(slot.value.id);
    }
    return outcome.answer;
  }

  /**
   * Abort a slot's job and wait, bounded, for the interrupted start to unwind.
   *
   * The wait keeps the interrupted provider start and the close from
   * interleaving over the same client: the start owns its own cleanup, and the
   * close reports that outcome instead of racing past it. The wait is bounded,
   * and it reports whether the start unwound. A start that ignores its abort
   * holds the session transition, so the caller escalates rather than waiting
   * for a close that would never begin.
   */
  async #abortJobAndWait(slot: TargetSlot): Promise<boolean> {
    const job = this.#jobs.get(slot.id);
    if (job === undefined) return true;
    job.controller.abort();
    return this.#waitForJobSettle(job);
  }

  /**
   * Wait, bounded, for an interrupted start to unwind.
   *
   * A provider start that ignores its abort never settles, so the wait stops
   * at the bound and reports that the start is still in flight.
   */
  async #waitForJobSettle(job: AnalysisJob): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    await Promise.race([
      job.promise.then(() => {
        settled = true;
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.#limits.jobSettleTimeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    return settled;
  }

  /**
   * Cancel a slot's job and release the slot for a replacement.
   *
   * The job stays registered until its start stopped, so a close that follows
   * finds it and takes the bounded wait and the forced close instead of
   * queueing behind a start that will never finish. A start that ignored its
   * abort holds the session transition, and the ordinary open serializes
   * behind it, so the slot is released with the forced close before it is
   * reused.
   *
   * The cancellation belongs to the job, so two requests that cancel the same
   * job wait for the same cancellation and the slot is force-closed once. The
   * cleanup only runs while the job still holds the slot, so a slot that took
   * on another analysis in the meantime keeps that analysis.
   */
  async #cancelJobAndWait(
    slot: TargetSlot,
  ): Promise<Result<null, AnalysisError>> {
    const job = this.#jobs.get(slot.id);
    if (job === undefined) return ok(null);
    const cancellation = job.cancellation ?? this.#cancelJob(slot, job);
    job.cancellation = cancellation;
    const cancelled = await cancellation;
    if (!cancelled.ok) {
      // The failed cancellation keeps the job registered, so the shared
      // operation is given up and a later cancel retries the cleanup.
      if (job.cancellation === cancellation) job.cancellation = undefined;
      return cancelled;
    }
    // The job leaves the slot when its cancellation released it. A slot that
    // took on another analysis keeps that analysis and the job it holds.
    this.#releaseJob(slot, job);
    return cancelled;
  }

  /**
   * Cancel one job and release the slot it holds.
   *
   * The start is aborted and the interrupted start is awaited, bounded. A
   * start that ignores its abort never settles, so the wait stops at the
   * bound and the slot is released with the forced close that releases the
   * pending client and retires the transition the wedged start holds.
   */
  async #cancelJob(
    slot: TargetSlot,
    job: AnalysisJob,
  ): Promise<Result<null, AnalysisError>> {
    job.controller.abort();
    if (await this.#waitForJobSettle(job)) return ok(null);
    // The start ignored its abort and still holds the session transition, so
    // the open that replaces it would queue behind that transition forever.
    // The forced close releases the pending client and retires the
    // transition, and the slot is reusable once the client is released.
    // The forced close belongs to the job that holds the slot: a slot that
    // took on another analysis in the meantime keeps that analysis.
    if (!this.#ownsJob(slot, job)) return ok(null);
    return this.#closeSlotWithoutTransition(
      slot,
      {},
      {
        clearRecords: false,
        closeOwnedProviderResources: false,
      },
    );
  }

  /** Whether the slot still holds the job that owns an operation. */
  #ownsJob(slot: TargetSlot, job: AnalysisJob): boolean {
    return this.#jobs.get(slot.id) === job;
  }

  /** Remove a job from its slot, if the slot still holds that job. */
  #releaseJob(slot: TargetSlot, job: AnalysisJob): void {
    if (!this.#ownsJob(slot, job)) return;
    this.#jobs.delete(slot.id);
  }

  async status(
    options: Parameters<BinarySessionPort["status"]>[0] = {},
  ): Promise<JsonValue> {
    const slot = this.#resolveSlot(options?.targetId, "binary_session");
    if (!slot.ok) throw slot.error;
    const job = this.#jobForSlot(slot.value);
    if (job?.state === "starting")
      // Without a declared budget the status reports the current state at
      // once. A caller that wants to wait names its own budget.
      await this.#waitForAnalysis(slot.value, "binary_session", {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        waitMs: options.waitMs ?? 0,
      });
    const base = await slot.value.session.status(options);
    if (typeof base !== "object" || base === null || Array.isArray(base))
      return base;
    const analysis =
      job === undefined
        ? undefined
        : {
            state: job.state,
            mode: job.mode,
            started_at: new Date(job.startedAt).toISOString(),
            elapsed_ms: this.#jobElapsedMs(job),
            ...(job.error === undefined
              ? {}
              : {
                  error: {
                    code: projectAnalysisError(job.error).code,
                    message: job.error.message,
                  },
                }),
          };
    const targetFields =
      job === undefined ||
      base.open === true ||
      job.state === "failed" ||
      job.state === "cancelled"
        ? {}
        : {
            open: true as const,
            ...binaryTargetSummary(job.target),
          };
    return {
      ...base,
      ...targetFields,
      target_id: slot.value.id,
      open_target_ids: this.targets().map(({ target_id }) => target_id),
      ...(this.#retainedSlots.size === 0
        ? {}
        : { retained_target_ids: [...this.#retainedSlots] }),
      ...(analysis === undefined ? {} : { analysis }),
    };
  }

  execute(
    name: Parameters<AnalysisOperationPort["execute"]>[0],
    arguments_: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const slot = this.#resolveSlot(options?.targetId, name);
    if (!slot.ok) return Promise.resolve(slot);
    const guard = this.#bindingGuard(slot.value, options?.targetId, name);
    return this.#waitForAnalysis(slot.value, name, options).then((ready) =>
      ready.ok
        ? slot.value.session.execute(name, arguments_, {
            ...options,
            ...(guard === undefined ? {} : { bindingGuard: guard }),
          })
        : ready,
    );
  }

  executeIfProviderReady(
    name: Parameters<BinarySessionPort["executeIfProviderReady"]>[0],
    arguments_: Readonly<Record<string, JsonValue>>,
    options?: Pick<ExecutionOptions, "signal" | "selectorOrigin" | "targetId">,
  ): Promise<Result<AnalysisExecution, AnalysisError> | undefined> {
    const slot = this.#resolveSlot(options?.targetId, name);
    if (!slot.ok) return Promise.resolve(slot);
    const job = this.#jobForSlot(slot.value);
    if (job !== undefined && job.state !== "ready")
      return Promise.resolve(undefined);
    return slot.value.session.executeIfProviderReady(name, arguments_, options);
  }

  withAdmittedAnalysis<Value>(
    operationName: string,
    signal: AbortSignal | undefined,
    operation: (analysis: AnalysisOperationPort) => Promise<Value>,
    targetId?: string,
    waitMs?: number,
  ): Promise<Result<Value, AnalysisError>> {
    const slot = this.#resolveSlot(targetId, operationName);
    if (!slot.ok) return Promise.resolve(slot);
    const guard = this.#bindingGuard(slot.value, targetId, operationName);
    return this.#waitForAnalysis(slot.value, operationName, {
      ...(signal === undefined ? {} : { signal }),
      ...(waitMs === undefined ? {} : { waitMs }),
    }).then((ready) =>
      ready.ok
        ? slot.value.session.withAdmittedAnalysis(
            operationName,
            signal,
            // The request runs against the slot it was admitted for, and the
            // Evidence it records belongs to that slot even when another open
            // made another slot current while the request ran.
            (analysis) =>
              this.#admittedSlots.run(slot.value, () => operation(analysis)),
            undefined,
            undefined,
            guard,
          )
        : ready,
    );
  }

  /**
   * The check that a request still addresses the binding it was admitted for.
   *
   * A handle names one live target. A foreground replacement can take the
   * slot over while a request waits for the slot's transition, so the
   * request would run against the target that replaced the one its handle
   * named. The check is made under the lifecycle admission that protects the
   * execution, and it reports the refusal the caller sees.
   *
   * A request without a handle addresses the current target, so it follows
   * the target that is current when it runs.
   */
  #bindingGuard(
    slot: TargetSlot,
    targetId: string | undefined,
    operation: string,
  ): BinaryBindingGuard | undefined {
    if (targetId === undefined) return undefined;
    const expected = this.#targetForSlot(slot);
    if (expected === undefined) return undefined;
    return () => {
      const current = this.#targetForSlot(slot);
      if (current !== undefined && sameSessionTarget(current, expected))
        return ok(undefined);
      return err(
        new AnalysisTargetNotOpenError(
          operation,
          targetId,
          [...this.#slots.values()]
            .filter((candidate) => this.#targetForSlot(candidate) !== undefined)
            .map(({ id }) => id),
        ),
      );
    };
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
    const slots = [...this.#slots.values()].filter(
      (slot) => this.#targetForSlot(slot) !== undefined,
    );
    // The explicit-close rule protects every open session. A Ghidra session
    // holds ephemeral edits that an external mutation would discard, so a
    // session that is not the current one must not bypass the rule.
    for (const slot of slots) {
      if (!refusesExternalMutation(slot.session.providerIdentity().id))
        continue;
      return Promise.resolve(err(externalMutationRefusal(operationName)));
    }
    const current = this.#currentSlot();
    return current.session
      .withAdmittedExternalMutation(
        path,
        signal,
        operation,
        retirementFailure,
        operationName,
        cleanupRecovery,
      )
      .then(async (admitted) => {
        if (!admitted.ok) return admitted;
        // The command may have changed any open artifact, so every other open
        // session retires its analysis too. A session that keeps its snapshot
        // would answer with analysis of bytes that no longer exist.
        for (const slot of slots) {
          if (slot === current) continue;
          const retired = await this.#retireSlotForExternalMutation(slot);
          if (!retired.ok)
            return err(retirementFailure(admitted.value, retired.error));
        }
        return admitted;
      });
  }

  /** Retire one session whose artifact an external mutation may have changed. */
  async #retireSlotForExternalMutation(
    slot: TargetSlot,
  ): Promise<Result<null, AnalysisError>> {
    slot.session.invalidateSnapshotForExternalMutation();
    const closed = await this.#closeSlot(
      slot,
      {},
      {
        clearRecords: false,
        closeOwnedProviderResources: false,
      },
    );
    if (!closed.ok) return closed;
    this.#retireClosedSlot(slot);
    return ok(null);
  }

  activeTarget(targetId?: string): BinaryTarget | undefined {
    if (targetId !== undefined) {
      const slot = this.#resolveSlotResult(targetId);
      return slot.ok ? this.#targetForSlot(slot.value) : undefined;
    }
    return this.#targetForSlot(this.#evidenceSlot());
  }

  /**
   * Identify the provider that owns one target.
   *
   * An explicit handle that is not open is an error, never the primary slot's
   * provider. The port cannot express a failure here, so the registry reports
   * it the way `status` does.
   */
  providerIdentity(
    operation?: AnalysisOperation,
    targetId?: string,
  ): ProviderIdentity {
    const slot = this.#resolveSlot(targetId, "provider identity");
    if (!slot.ok) throw slot.error;
    return slot.value.session.providerIdentity(operation);
  }

  /** Report the profile of one target; an unknown handle has no profile. */
  analysisProfile(
    operation?: AnalysisOperation,
    targetId?: string,
  ): AnalysisProfileCommitment | undefined {
    if (targetId !== undefined) {
      const slot = this.#resolveSlot(targetId, "analysis profile");
      return slot.ok
        ? slot.value.session.analysisProfile(operation)
        : undefined;
    }
    return this.#evidenceSlot().session.analysisProfile(operation);
  }

  /** Report whether one target may replay a snapshot; an unknown handle may not. */
  allowsSnapshotReplay(
    operation: AnalysisOperation,
    targetId?: string,
  ): boolean {
    if (targetId !== undefined) {
      const slot = this.#resolveSlot(targetId, "snapshot replay");
      return slot.ok
        ? slot.value.session.allowsSnapshotReplay(operation)
        : false;
    }
    return this.#evidenceSlot().session.allowsSnapshotReplay(operation);
  }

  /** Invalidate one target's cached Evidence; an unknown handle owns none. */
  invalidateSnapshotForExternalMutation(targetId?: string): void {
    if (targetId !== undefined) {
      const slot = this.#resolveSlot(targetId, "external mutation");
      if (!slot.ok) return;
      slot.value.session.invalidateSnapshotForExternalMutation();
      return;
    }
    this.#evidenceSlot().session.invalidateSnapshotForExternalMutation();
  }

  exportAnalysisSnapshot(
    targetId?: string,
  ): Result<AnalysisSnapshot, AnalysisError> {
    if (targetId !== undefined) {
      const slot = this.#resolveSlot(targetId, "snapshot export");
      return slot.ok
        ? slot.value.session.exportAnalysisSnapshot()
        : err(slot.error);
    }
    return this.#evidenceSlot().session.exportAnalysisSnapshot();
  }

  importAnalysisSnapshot(
    snapshot: AnalysisSnapshot,
    targetId?: string,
  ): Result<number, AnalysisError> {
    if (targetId !== undefined) {
      const slot = this.#resolveSlot(targetId, "snapshot import");
      return slot.ok
        ? slot.value.session.importAnalysisSnapshot(snapshot)
        : err(slot.error);
    }
    return this.#evidenceSlot().session.importAnalysisSnapshot(snapshot);
  }

  recordWorkflowSnapshot(
    input: WorkflowSnapshotRecordInput,
  ): Result<null, EvidenceIntegrityError> {
    return this.#evidenceSlot().session.recordWorkflowSnapshot(input);
  }

  onAvailabilityChanged(listener: () => void | Promise<void>): () => void {
    this.#availabilityListeners.add(listener);
    return () => this.#availabilityListeners.delete(listener);
  }

  onAnalysisSnapshotChanged(listener: () => void | Promise<void>): () => void {
    this.#snapshotListeners.add(listener);
    return () => this.#snapshotListeners.delete(listener);
  }

  // Investigation records stay session-wide. The slot the request was
  // admitted for owns the target binding used to attach new unknowns and the
  // only active snapshot cache.
  recordEvidence(
    evidence: Evidence,
  ): ReturnType<BinarySessionPort["recordEvidence"]> {
    return this.#evidenceSlot().session.recordEvidence(evidence);
  }

  hasEvidence(evidenceId: string): boolean {
    return this.#evidenceSlot().session.hasEvidence(evidenceId);
  }

  evidenceById(evidenceId: string): Evidence | undefined {
    return this.#evidenceSlot().session.evidenceById(evidenceId);
  }

  evidenceForAnalysis(evidenceId: string): Evidence | undefined {
    return this.#evidenceSlot().session.evidenceForAnalysis(evidenceId);
  }

  exportEvidenceBundle(): EvidenceBundle {
    return this.#evidenceSlot().session.exportEvidenceBundle();
  }

  evidenceBundleForSerialization(): EvidenceBundle {
    return this.#evidenceSlot().session.evidenceBundleForSerialization();
  }

  writeAnalysisSnapshot(
    snapshot: AnalysisSnapshot,
    path: string,
    overwrite: boolean,
  ): ReturnType<BinarySession["writeAnalysisSnapshot"]> {
    return this.#evidenceSlot().session.writeAnalysisSnapshot(
      snapshot,
      path,
      overwrite,
    );
  }

  closeWriteResources(): Promise<Result<null, AnalysisError>> {
    return this.#evidenceSlot().session.closeWriteResources();
  }

  importEvidenceBundle(
    bundle: unknown,
  ): ReturnType<BinarySession["importEvidenceBundle"]> {
    return this.#evidenceSlot().session.importEvidenceBundle(bundle);
  }

  recordUnknown(
    input: RecordUnknownInput,
  ): Result<ResidualUnknown, AnalysisError> {
    return this.#evidenceSlot().session.recordUnknown(input);
  }

  recordEvidenceWithUnknown(
    evidence: Evidence,
    input: RecordUnknownInput,
  ): Result<ResidualUnknown | null, AnalysisError> {
    return this.#evidenceSlot().session.recordEvidenceWithUnknown(
      evidence,
      input,
    );
  }

  updateUnknown(
    input: UpdateUnknownInput,
  ): Result<ResidualUnknown, AnalysisError> {
    return this.#evidenceSlot().session.updateUnknown(input);
  }

  listUnknowns(
    filters: {
      readonly status?: UnknownStatus;
      readonly severity?: ResidualUnknown["severity"];
      readonly domain?: string;
    } = {},
  ): ResidualUnknown[] {
    return this.#evidenceSlot().session.listUnknowns(filters);
  }

  listUnknownsPage(query: UnknownQuery = {}): UnknownPage {
    return this.#evidenceSlot().session.listUnknownsPage(query);
  }

  verifyUnknownResolution(unknownId: string): Result<
    {
      readonly valid: boolean;
      readonly truthVerified: boolean;
      readonly unknown: ResidualUnknown;
    },
    UnknownRegistryError
  > {
    return this.#evidenceSlot().session.verifyUnknownResolution(unknownId);
  }

  #createSlot(): TargetSlot {
    const session = new BinarySession(
      this.#router,
      this.#records,
      this.#bundleResourceFactory,
    );
    const slot: TargetSlot = {
      id: randomUUID(),
      session,
      handleTarget: undefined,
      startPermits: new Set(),
      retainedPermits: new Set(),
    };
    session.onAvailabilityChanged(() => this.#emitAvailabilityChanged());
    session.onAnalysisSnapshotChanged(() => this.#emitSnapshotChanged());
    return slot;
  }

  /**
   * Drop one slot from the registry.
   *
   * `fallback` names the target a call without an explicit handle addresses
   * once the removed slot was current. `primary` is the fallback for a slot
   * that never became usable, so the server keeps addressing the slot every
   * request addresses by default. `first-open` is the fallback for a slot that
   * was closed, so the server keeps addressing a slot that still holds an open
   * target. Only a successful close or a failed open removes a slot; a failed
   * close keeps the slot, its registration, and the resource it still owns.
   */
  #removeSlot(slot: TargetSlot, fallback: "primary" | "first-open"): void {
    this.#jobs.get(slot.id)?.controller.abort();
    this.#jobs.delete(slot.id);
    this.#slots.delete(slot.id);
    this.#reservedSlots.delete(slot.id);
    if (this.#currentId !== slot.id) return;
    this.#currentId =
      fallback === "primary"
        ? this.#primary.id
        : (this.#firstOpenSlot()?.id ?? this.#primary.id);
  }

  #firstOpenSlot(): TargetSlot | undefined {
    return [...this.#slots.values()].find(
      (slot) => this.#targetForSlot(slot) !== undefined,
    );
  }

  /**
   * Retire a slot whose provider was released.
   *
   * The slot no longer holds a target, so it leaves the registry, its
   * retained resource is gone and the start permit a retained cleanup kept
   * is given back.
   */
  #retireClosedSlot(slot: TargetSlot): void {
    this.#releaseRetainedPermit(slot);
    this.#retainedSlots.delete(slot.id);
    this.#removeSlot(slot, "first-open");
  }

  #openSlotCount(): number {
    // A reserved slot holds its capacity before it holds a target, so an
    // overlapping open cannot slip past the limit.
    let count = this.#reservedSlots.size;
    for (const slot of this.#slots.values())
      if (this.#targetForSlot(slot) !== undefined) count += 1;
    return count;
  }

  #slotById(targetId: string): TargetSlot | undefined {
    if (this.#primary.id === targetId) return this.#primary;
    return this.#slots.get(targetId);
  }

  #targetForSlot(slot: TargetSlot | undefined): BinaryTarget | undefined {
    if (slot === undefined) return undefined;
    return slot.session.activeTarget() ?? this.#jobs.get(slot.id)?.target;
  }

  #jobForSlot(slot: TargetSlot): AnalysisJob | undefined {
    return this.#jobs.get(slot.id);
  }

  /**
   * The job that binds a slot, or undefined when the slot may open again.
   *
   * A job that failed or was cancelled left the slot with no target, so the
   * next open must be able to try again instead of replaying the stale
   * failure. A job that is still starting, or that reached `ready`, keeps the
   * slot bound to it: the target really is open, and reopening it returns the
   * same handle.
   */
  #blockingJob(slot: TargetSlot): AnalysisJob | undefined {
    const job = this.#jobs.get(slot.id);
    if (job === undefined) return undefined;
    if (!jobBindsSlot(job)) {
      this.#jobs.delete(slot.id);
      return undefined;
    }
    return job;
  }

  /**
   * The job that binds a slot, without dropping a job that already failed.
   *
   * A job that failed or was cancelled binds nothing, so the slot answers
   * for the target its session holds. This reports the binding without
   * changing the registry, so an observation can be taken while the job is
   * still there.
   */
  #boundJob(slot: TargetSlot): AnalysisJob | undefined {
    const job = this.#jobs.get(slot.id);
    return job !== undefined && jobBindsSlot(job) ? job : undefined;
  }

  async #waitForAnalysis(
    slot: TargetSlot,
    operation: string,
    options: Pick<ExecutionOptions, "signal" | "waitMs"> | undefined,
  ): Promise<Result<undefined, AnalysisError>> {
    const job = this.#jobForSlot(slot);
    if (job === undefined || job.state === "ready") return ok(undefined);
    if (job.state === "failed")
      return err(job.error ?? new AnalysisCancelledError(operation));
    if (job.state === "cancelled")
      return err(new AnalysisCancelledError(operation));
    if (isAborted(options?.signal))
      return err(new AnalysisCancelledError(operation));
    // The wait budget belongs to the tool that declares it. A call that
    // declares no budget waits for nothing; a call that declares one passes
    // its own budget. A budget that is not a finite number is not a budget; it
    // falls back to no wait.
    const requested = options?.waitMs ?? 0;
    const waitMs = Number.isFinite(requested)
      ? Math.min(MAX_WAIT_MS, Math.max(0, requested))
      : 0;
    if (waitMs === 0)
      return err(
        new AnalysisInProgressError(
          operation,
          slot.id,
          this.#jobElapsedMs(job),
        ),
      );
    const outcome = await new Promise<
      "ready" | "failed" | "aborted" | "timeout"
    >((resolve) => {
      let settled = false;
      const finish = (
        value: "ready" | "failed" | "aborted" | "timeout",
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options?.signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const timer = setTimeout(() => finish("timeout"), waitMs);
      timer.unref?.();
      const onAbort = (): void => finish("aborted");
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      void job.promise.then(() =>
        finish(job.state === "ready" ? "ready" : "failed"),
      );
    });
    if (outcome === "ready") return ok(undefined);
    if (outcome === "aborted")
      return err(new AnalysisCancelledError(operation));
    if (outcome === "failed")
      return err(job.error ?? new AnalysisCancelledError(operation));
    return err(
      new AnalysisInProgressError(operation, slot.id, this.#jobElapsedMs(job)),
    );
  }

  #slotForPath(path: string): TargetSlot | undefined {
    return [...this.#slots.values()].find((slot) => {
      const target = this.#targetForSlot(slot);
      return target?.path === path || target?.sourcePath === path;
    });
  }

  /** The slot a call without an explicit target handle addresses. */
  #currentSlot(): TargetSlot {
    return this.#slotById(this.#currentId) ?? this.#primary;
  }

  /**
   * The slot that owns the Evidence of the request in flight.
   *
   * A request is admitted for one slot and runs against it, so its Evidence
   * belongs to that slot. Another open may make another slot current while
   * the request runs, and the Evidence of a request that started on the first
   * slot does not belong to the second one. A call outside an admitted
   * request addresses the current slot.
   */
  #evidenceSlot(): TargetSlot {
    return this.#admittedSlots.getStore() ?? this.#currentSlot();
  }

  #resolveSlot(
    targetId: string | undefined,
    operation: string,
  ): Result<TargetSlot, AnalysisError> {
    if (targetId === undefined)
      return ok(this.#slotById(this.#currentId) ?? this.#primary);
    const slot = this.#slotById(targetId);
    if (slot !== undefined && this.#targetForSlot(slot) !== undefined)
      return ok(slot);
    return err(
      new AnalysisTargetNotOpenError(
        operation,
        targetId,
        [...this.#slots.values()]
          .filter((candidate) => this.#targetForSlot(candidate) !== undefined)
          .map(({ id }) => id),
      ),
    );
  }

  #resolveSlotResult(
    targetId: string | undefined,
  ): Result<TargetSlot, AnalysisError> {
    return this.#resolveSlot(targetId, "target lookup");
  }

  /**
   * Resolve the slot a close addresses.
   *
   * A slot whose close failed keeps its registration and the resource it
   * still owns, so a later close can retry that cleanup even though the
   * target itself is already closed.
   */
  #resolveCloseSlot(
    targetId: string | undefined,
  ): Result<TargetSlot, AnalysisError> {
    if (targetId === undefined)
      return ok(this.#slotById(this.#currentId) ?? this.#primary);
    const slot = this.#slotById(targetId);
    if (slot !== undefined && this.#slots.has(slot.id)) return ok(slot);
    return err(
      new AnalysisTargetNotOpenError(
        "close_binary",
        targetId,
        [...this.#slots.values()]
          .filter((candidate) => this.#targetForSlot(candidate) !== undefined)
          .map(({ id }) => id),
      ),
    );
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
      const closed = await this.#closeSlot(
        slot,
        {},
        {
          clearRecords: false,
          closeOwnedProviderResources: false,
        },
      );
      if (!closed.ok) {
        // The slot keeps its registration and its retained resource, and its
        // handle stays reported so a later close can retry the cleanup. It is
        // no longer an open target.
        this.#retainedSlots.add(slot.id);
        this.#jobs.delete(slot.id);
        return closed;
      }
      this.#retireClosedSlot(slot);
    }
    return ok(null);
  }

  async #acquireStartPermit(
    operation: string,
    signal: AbortSignal | undefined,
    permit: StartPermit,
  ): Promise<Result<undefined, AnalysisError>> {
    if (isAborted(signal)) return err(new AnalysisCancelledError(operation));
    if (this.#activeStarts >= this.#limits.maxConcurrentAnalyses) {
      // A provider a forced close could not release keeps the permit this
      // start would wait for, and the cleanup that owns that permit is
      // retried inside the open. Waiting first would wait for an open that
      // never begins, so the retained cleanup is retried before the wait.
      await this.#retryRetainedCleanups();
      // The retry is an await, so the request may have been cancelled while
      // it ran. A cancelled request takes no permit and enters no queue: the
      // abort event has already fired, so a listener attached now would never
      // run and the request would wait for a permit that may never come.
      if (isAborted(signal)) return err(new AnalysisCancelledError(operation));
    }
    if (this.#activeStarts < this.#limits.maxConcurrentAnalyses) {
      this.#activeStarts += 1;
      permit.held = true;
      return ok(undefined);
    }
    return new Promise((resolve) => {
      const grant = (): void => {
        this.#activeStarts += 1;
        permit.held = true;
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

  /** Give one start permit back, at most once. */
  #releaseStartPermit(permit: StartPermit): void {
    if (!permit.held) return;
    permit.held = false;
    this.#activeStarts = Math.max(0, this.#activeStarts - 1);
    const next = this.#startQueue.shift();
    next?.();
  }

  /**
   * Give back the permits the starts of a slot still hold.
   *
   * A start that ignored its abort never settles, so its permit would never
   * be released. The close that gave up on the start releases it, so a later
   * open is not queued behind a start that will never finish.
   */
  #releaseSlotPermits(slot: TargetSlot): void {
    for (const permit of slot.startPermits) this.#releaseStartPermit(permit);
    slot.startPermits.clear();
  }

  /**
   * Keep the permits of the starts a slot runs.
   *
   * The provider may still be running, so the analysis cap has to count it
   * until the retained cleanup releases it. The start may no longer give the
   * permit back, so the cleanup owns it from here.
   */
  #retainSlotPermits(slot: TargetSlot): void {
    if (slot.retainedPermits.size > 0) return;
    const outstanding = [...slot.startPermits];
    slot.startPermits.clear();
    if (outstanding.length === 0) {
      // The start settled while the close was running and gave the permit
      // back, but the provider it started may still be alive. The retained
      // cleanup takes a permit of its own.
      this.#retainProviderPermit(slot);
      return;
    }
    for (const permit of outstanding) {
      permit.retained = true;
      slot.retainedPermits.add(permit);
    }
  }

  /**
   * Count a provider that may still be running against the analysis limit.
   *
   * A cleanup that could not release its provider leaves that provider
   * behind, so the limit has to count it until the retained cleanup releases
   * it. The permit is one of its own, because the start it belonged to gave
   * its permit back.
   */
  #retainProviderPermit(slot: TargetSlot): void {
    slot.retainedPermits.add({ held: true, retained: true });
    this.#activeStarts += 1;
  }

  /** Give back the permits a retained cleanup owns. */
  #releaseRetainedPermit(slot: TargetSlot): void {
    for (const permit of slot.retainedPermits) this.#releaseStartPermit(permit);
    slot.retainedPermits.clear();
  }

  /**
   * Retry the cleanup of the providers a forced close could not release.
   *
   * A retained cleanup keeps the start permit, so a later start waits for it.
   * The wait would never end: the open retries the cleanup, and the open is
   * queued behind the permit the cleanup owns. The cleanup is retried before
   * the permit is taken instead, and a successful retry gives the permit back.
   *
   * One retry runs at a time, so two overlapping opens do not close the same
   * provider twice.
   */
  async #retryRetainedCleanups(): Promise<void> {
    const inFlight = this.#retainedCleanupRetry;
    if (inFlight !== undefined) return inFlight;
    const retry = this.#runRetainedCleanupRetry();
    this.#retainedCleanupRetry = retry;
    void retry.then(
      () => {
        if (this.#retainedCleanupRetry === retry)
          this.#retainedCleanupRetry = undefined;
      },
      () => {
        if (this.#retainedCleanupRetry === retry)
          this.#retainedCleanupRetry = undefined;
      },
    );
    return retry;
  }

  /** Retry every retained cleanup and release the permits they own. */
  async #runRetainedCleanupRetry(): Promise<void> {
    const slots = new Set<TargetSlot>([...this.#slots.values(), this.#primary]);
    for (const slot of slots) {
      if (slot.retainedPermits.size === 0) continue;
      const released = await slot.session.releasePendingProvider();
      if (!released.ok) continue;
      // The provider is gone, so the analysis cap stops counting it and the
      // slot is no longer reported as a target whose cleanup failed.
      this.#releaseRetainedPermit(slot);
      this.#retainedSlots.delete(slot.id);
    }
  }

  #emitAvailabilityChanged(): void {
    for (const listener of this.#availabilityListeners) {
      try {
        const notification = listener();
        if (notification !== undefined)
          void notification.catch(() => undefined);
      } catch (cause: unknown) {
        void cause;
      }
    }
  }

  #emitSnapshotChanged(): void {
    for (const listener of this.#snapshotListeners) {
      try {
        const notification = listener();
        if (notification !== undefined)
          void notification.catch(() => undefined);
      } catch (cause: unknown) {
        void cause;
      }
    }
  }
}

const isAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;

/** Whether a job still binds its slot. */
const jobBindsSlot = (job: AnalysisJob): boolean =>
  job.state !== "failed" && job.state !== "cancelled";
