import { RegularFileCleanupFailure } from "../RegularFileRead.js";
import { matchFunctionInventories } from "../../domain/native/matchFunctionInventories.js";
import { readImmutableEvidenceBundle } from "../EvidenceBundleFiles.js";
import type { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { setImmediate } from "node:timers/promises";
import { matchNativeFunctionsInputSchema } from "../../contracts/native/functionMatchingContracts.js";
import { retainedEvidenceReferenceSchema } from "../../domain/evidenceReference.js";
import {
  createEvidence,
  parseEvidence,
  type Evidence,
} from "../../domain/evidence.js";
import { readFunctionInventory } from "../../domain/native/functionInventory.js";
import { nativeFunctionMatchingSchema } from "../../domain/native/functionMatching.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  resolveEvidenceInput,
  type EvidenceLookup,
} from "../EvidenceInputResolver.js";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import { FUNCTION_COMPARISON_PROVIDER } from "../InvestigationProviders.js";

const OPERATION = "match_native_functions";
// Budget includes decoded observations, grouping/index nodes and retained result
// representation. It is charged before cloning/expanding admitted observations.
export const NATIVE_MATCHING_REPRESENTATION_BYTES = 96 * 1024 * 1024;
export interface NativeFunctionMatchingResult {
  readonly evidence: Evidence;
  readonly sources: readonly Evidence[];
}

/** Pair retained inventories without opening targets, decompiling or reading files. */
export const matchNativeFunctions = async (
  rawInput: unknown,
  options?: ExecutionOptions,
  lookup?: EvidenceLookup,
): Promise<Result<NativeFunctionMatchingResult, AnalysisError>> => {
  try {
    const admission = new NativeMatchingAdmission(options?.signal);
    const checkpoint = admission.checkpoint;
    await setImmediate();
    await checkpoint();
    const parsed = matchNativeFunctionsInputSchema.safeParse(rawInput);
    if (!parsed.success)
      return err(
        analysisInputErrorFromIssues(OPERATION, parsed.error.issues, rawInput),
      );
    const sources = new Map<string, Evidence>();
    const resolve = async (input: unknown): Promise<Evidence> => {
      const reference = retainedEvidenceReferenceSchema.safeParse(input);
      let raw = input;
      if (reference.success) {
        const found = resolveEvidenceInput(reference.data, lookup);
        if (!found.ok) throw found.error;
        raw = found.value;
      }
      await admission.admit(raw);
      const evidence = parseEvidence(raw);
      const cached = sources.get(evidence.evidence_id);
      if (cached !== undefined) return cached;
      sources.set(evidence.evidence_id, evidence);
      return evidence;
    };
    const left = await resolve(parsed.data.left),
      right = await resolve(parsed.data.right);
    const observations = async (inputs: readonly unknown[]) => {
      const result: Evidence[] = [];
      const seen = new Set<string>();
      for (const input of inputs) {
        const record = await resolve(input);
        if (!seen.has(record.evidence_id)) {
          seen.add(record.evidence_id);
          result.push(record);
        }
      }
      return result;
    };
    const leftObservations = await observations(parsed.data.left_observations);
    const rightObservations = await observations(
      parsed.data.right_observations,
    );
    const leftFunctions = await readFunctionInventory(
      left,
      leftObservations,
      checkpoint,
    );
    const rightFunctions = await readFunctionInventory(
      right,
      rightObservations,
      checkpoint,
    );
    const compatible =
      left.subject?.architecture != null &&
      left.subject.architecture === right.subject?.architecture;
    const { matches, summary } = await matchFunctionInventories(
      leftFunctions,
      rightFunctions,
      { identicalBytesComparable: compatible, checkpoint },
    );
    const limitations = [
      ...new Set([
        ...left.limitations.map((x) => `Left: ${x}`),
        ...right.limitations.map((x) => `Right: ${x}`),
        "Coverage is restricted to the supplied provider-observed inventories; missing/truncated inventory facts never prove absence from either binary.",
        "Only unique exact symbols and bytes are paired. Compatible observed CFG/call/string fingerprints propose unresolved candidates, never identity or equivalence. Missing structural coverage stays unknown.",
        "Name or byte correspondence is not behavioral equivalence; use analyze_function for selected pairs, then compare_functions. Existing dossier pairs include directly usable retained-reference inputs.",
        ...(!compatible
          ? [
              "Identical-byte matching unavailable: input architectures are missing or differ.",
            ]
          : []),
      ]),
    ];
    const report = nativeFunctionMatchingSchema.parse({
      left: {
        evidence_id: left.evidence_id,
        sha256: left.subject!.digest.sha256,
        functions: leftFunctions.length,
      },
      right: {
        evidence_id: right.evidence_id,
        sha256: right.subject!.digest.sha256,
        functions: rightFunctions.length,
      },
      scope: "provider-observed-inputs",
      source_coverage: {
        status:
          summary.only_left + summary.only_right + summary.unresolved > 0
            ? "partial"
            : "complete-within-inputs",
        left_inventory_completeness: "unknown",
        right_inventory_completeness: "unknown",
        left_byte_fingerprints: leftFunctions.filter(
          (x) => x.fingerprint !== null,
        ).length,
        left_structural_candidates: leftFunctions.filter(
          (x) => x.member.structural_candidate_sha256 !== null,
        ).length,
        right_structural_candidates: rightFunctions.filter(
          (x) => x.member.structural_candidate_sha256 !== null,
        ).length,
        right_byte_fingerprints: rightFunctions.filter(
          (x) => x.fingerprint !== null,
        ).length,
      },
      summary,
      matches,
      limitations,
    });
    await checkpoint();
    const evidence = createEvidence(undefined, FUNCTION_COMPARISON_PROVIDER, {
      operation: OPERATION,
      predicateType: "rea.native-function-matching",
      confidence: "derived",
      authority: "analyst-inference",
      parameters: {
        left_evidence_id: left.evidence_id,
        right_evidence_id: right.evidence_id,
        left_observation_ids: leftObservations.map((x) => x.evidence_id),
        right_observation_ids: rightObservations.map((x) => x.evidence_id),
        algorithm: "exact-symbol-body-bytes-and-structural-candidates-v1",
      },
      result: report,
      limitations,
      evidenceLinks: [...sources.keys()].sort(),
    });
    await checkpoint();
    return ok({ evidence, sources: [...sources.values()] });
  } catch (cause: unknown) {
    if (options?.signal?.aborted)
      return err(
        new AnalysisCancelledError(OPERATION, { cause: options.signal.reason }),
      );
    if (cause instanceof AnalysisError) return err(cause);
    return err(
      new AnalysisInputError(OPERATION, { cause }, [
        {
          path: [],
          reason: "invalid_value",
          message:
            cause instanceof Error
              ? cause.message
              : "Invalid native matching observations",
        },
      ]),
    );
  }
};

/** Budget the actual selected observations, before cloning or index allocation. */
class NativeMatchingAdmission {
  #remaining = NATIVE_MATCHING_REPRESENTATION_BYTES;
  #work = 0;
  readonly #seen = new WeakSet<object>();
  constructor(readonly signal?: AbortSignal) {}
  readonly checkpoint = async (bytes = 0): Promise<void> => {
    this.#remaining -= bytes;
    if (this.#remaining < 0)
      throw new AnalysisResourceConstraintError(
        OPERATION,
        "capacity",
        "Native function matching exceeds representation capacity",
        { maximum_bytes: NATIVE_MATCHING_REPRESENTATION_BYTES },
      );
    this.signal?.throwIfAborted();
    if (++this.#work % 256 === 0)
      await setImmediate(
        undefined,
        this.signal === undefined ? {} : { signal: this.signal },
      );
  };
  async admit(root: unknown): Promise<void> {
    const pending: Iterator<unknown>[] = [[root][Symbol.iterator]()];
    while (pending.length) {
      const next = pending[pending.length - 1]!.next();
      if (next.done) {
        pending.pop();
        continue;
      }
      const value = next.value;
      if (typeof value === "object" && value !== null) {
        if (this.#seen.has(value)) continue;
        this.#seen.add(value);
        await this.checkpoint(128);
        // Iterator traversal avoids a second width-sized array of child values.
        pending.push(
          (function* () {
            for (const key in value)
              if (Object.hasOwn(value, key)) {
                yield key;
                yield (value as Record<string, unknown>)[key];
              }
          })(),
        );
      } else
        await this.checkpoint(
          typeof value === "string" ? 64 + value.length * 4 : 128,
        );
    }
  }
}

/** Load selected portable records; do not retain unrelated records across bundles. */
export const matchNativeFunctionsFromBundles = async (
  input: unknown,
  paths: readonly string[],
  resources: ArtifactResourceScope,
  options?: ExecutionOptions,
): Promise<Result<NativeFunctionMatchingResult, AnalysisError>> => {
  try {
    const parsed = matchNativeFunctionsInputSchema.safeParse(input);
    if (!parsed.success)
      return err(
        analysisInputErrorFromIssues(OPERATION, parsed.error.issues, input),
      );
    const selected = new Set<string>();
    for (const value of [
      parsed.data.left,
      parsed.data.right,
      ...parsed.data.left_observations,
      ...parsed.data.right_observations,
    ]) {
      const reference = retainedEvidenceReferenceSchema.safeParse(value);
      if (reference.success) selected.add(reference.data.evidence_id);
    }
    const records = new Map<string, Evidence>(),
      admission = new NativeMatchingAdmission(options?.signal);
    for (const path of paths) {
      const bundle = await readImmutableEvidenceBundle(
        path,
        options?.signal,
        resources,
      );
      if (!bundle.ok) return bundle;
      for (const record of bundle.value.records)
        if (
          selected.has(record.evidence_id) &&
          !records.has(record.evidence_id)
        ) {
          await admission.admit(record);
          records.set(record.evidence_id, record);
        }
    }
    return await matchNativeFunctions(parsed.data, options, (id) =>
      records.get(id),
    );
  } catch (cause: unknown) {
    // This marker carries the exact descriptor owner; the caller must finish
    // that owner before classifying cancellation or unexpected I/O failures.
    if (cause instanceof RegularFileCleanupFailure) throw cause;
    if (options?.signal?.aborted)
      return err(
        new AnalysisCancelledError(OPERATION, { cause: options.signal.reason }),
      );
    if (cause instanceof AnalysisError) return err(cause);
    return err(new AnalysisInputError(OPERATION, { cause }));
  }
};
