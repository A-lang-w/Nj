import { z } from "zod";

import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type { RegexMatchingDeadline } from "../config/regexMatchingDeadline.js";
import type { RegexWorkerHeapRequest } from "../config/regexWorkerHeapRequest.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisInputError,
  AnalysisProtocolError,
} from "../domain/analysisErrorCore.js";
import {
  analysisSearchPredicate,
  analysisSearchQuerySchema,
} from "../domain/analysisSearch.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import type { EvidenceLocation } from "../domain/evidence.js";
import { combineFunctionRelationshipCoverage } from "../domain/functionCallCoverage.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import type { RelationshipCoverage } from "../domain/relationshipCoverage.js";
import { err, ok, type Result } from "../domain/result.js";
import { matchRegexValues } from "../process/RegexMatcher.js";
import type {
  BinaryNinjaBridgeRequestError,
  BinaryNinjaHeadlessBridgeProcess,
} from "./BinaryNinjaHeadlessBridgeProcess.js";
import {
  bridgeContainingSchema,
  bridgeFunctionIdentitySchema,
  bridgeFunctionResultSchema,
  bridgeStringSchema,
  bridgeXrefsSchema,
  formatInstruction,
  projectAnalysisString,
  projectContainingProcedure,
  projectFunctionDossier,
  projectInstructionWindow,
  projectProcedureRow,
  type BinaryNinjaBridgeFunctionResult,
} from "./BinaryNinjaHeadlessProtocolValues.js";
import {
  BINARY_NINJA_HEADLESS_PROVIDER_IDENTITY,
  binaryNinjaHeadlessLimitationsFor,
  type BinaryNinjaHeadlessOperation,
} from "./BinaryNinjaHeadlessProviderCapabilities.js";

/** One operation's normalized result plus the Evidence facts it established. */
export interface BinaryNinjaOperationOutcome {
  readonly result: JsonValue;
  readonly rawResult?: JsonValue;
  readonly limitations?: readonly string[];
  readonly locations?: readonly EvidenceLocation[];
  readonly relationshipCoverage?: RelationshipCoverage;
}

export interface BinaryNinjaRegexOptions {
  readonly regexMatchingDeadline?: RegexMatchingDeadline | undefined;
  readonly regexWorkerHeapRequest?: RegexWorkerHeapRequest | undefined;
}

type FunctionOperation =
  | "procedure_address"
  | "procedure_pseudo_code"
  | "procedure_assembly"
  | "procedure_callers"
  | "procedure_callees"
  | "read_function_instructions"
  | "analyze_function";

/** Bridge facets each function operation needs; nothing more is computed. */
const FUNCTION_FACETS: Record<FunctionOperation, readonly string[]> = {
  procedure_address: [],
  procedure_pseudo_code: ["pseudocode"],
  procedure_assembly: ["assembly"],
  procedure_callers: ["callers"],
  procedure_callees: ["callees"],
  read_function_instructions: ["assembly"],
  analyze_function: [
    "pseudocode",
    "assembly",
    "callers",
    "callees",
    "references",
    "blocks",
    "locals",
    "comments",
    "strings_names",
  ],
};

const isFunctionOperation = (
  operation: BinaryNinjaHeadlessOperation,
): operation is FunctionOperation => operation in FUNCTION_FACETS;

const isHexAddress = (value: unknown): value is string =>
  typeof value === "string" && /^0x[0-9a-fA-F]+$/u.test(value);

const canonicalAddress = (value: string): string =>
  `0x${BigInt(value).toString(16)}`;

const compareAddresses = (left: string, right: string): number => {
  const difference = BigInt(left) - BigInt(right);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
};

const callerCoverage = (): RelationshipCoverage => ({
  status: "unknown",
  limited_directions: ["callers"],
  reason:
    "Binary Ninja reports functions containing resolved direct call sites; unresolved indirect calls elsewhere in the program are not attributed, so caller completeness is not established.",
});

const calleeCoverage = (
  result: BinaryNinjaBridgeFunctionResult,
): RelationshipCoverage => {
  const unresolved = result.callees?.unresolved_sites.length ?? 0;
  return unresolved === 0
    ? { status: "complete" }
    : {
        status: "partial",
        limited_directions: ["callees"],
        limitations: [
          `${String(unresolved)} call sites have no target resolved by Binary Ninja and are reported as unresolved calls.`,
        ],
      };
};

/** Apply the public contract and this adapter's explicit-address boundary before startup. */
export const parseBinaryNinjaHeadlessInput = (
  operation: BinaryNinjaHeadlessOperation,
  parameters: Readonly<Record<string, JsonValue>>,
  target: BinaryTarget,
): Result<Readonly<Record<string, JsonValue>>, AnalysisInputError> => {
  const parsed = toolContract(operation).inputSchema.safeParse(parameters);
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(operation, parsed.error.issues, parameters, {
        cause: parsed.error,
      }),
    );
  const issue = (
    path: string,
    reason: "missing_argument" | "invalid_format" | "invalid_value",
    message: string,
  ) =>
    err(
      new AnalysisInputError(operation, undefined, [
        { path: [path], reason, message },
      ]),
    );
  const value: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(parsed.data))
    if (entry !== undefined) value[key] = jsonValueSchema.parse(entry);
  if (
    typeof value.document === "string" &&
    value.document !== target.path &&
    value.document !== target.sourcePath
  )
    return issue(
      "document",
      "invalid_value",
      "The document must be the admitted target path; omit document or pass that path.",
    );
  if (
    (operation === "xrefs" || operation === "resolve_containing_procedure") &&
    value.address === undefined
  )
    return issue(
      "address",
      "missing_argument",
      "Headless Binary Ninja analysis requires an explicit 0x-prefixed address.",
    );
  if (value.address !== undefined && !isHexAddress(value.address))
    return issue(
      "address",
      "invalid_format",
      "Binary Ninja addresses are 0x-prefixed hexadecimal.",
    );
  if (typeof value.procedure === "string" && value.procedure.length === 0)
    return issue(
      "procedure",
      "invalid_value",
      "Supply a function name or 0x entry address.",
    );
  if (value.mode === "regex" && typeof value.pattern === "string")
    try {
      new RegExp(value.pattern, value.case_sensitive === true ? "u" : "iu");
    } catch (cause: unknown) {
      return err(
        new AnalysisInputError(operation, { cause }, [
          {
            path: ["pattern"],
            reason: "invalid_format",
            message: "Supply a valid ECMAScript Unicode regular expression.",
          },
        ]),
      );
    }
  return ok(value);
};

/** Attribute a bridge request failure: caller selector mistakes stay input errors. */
export const binaryNinjaRequestFailure = (
  operation: string,
  cause: BinaryNinjaBridgeRequestError,
  options: ExecutionOptions | undefined,
): AnalysisError => {
  const selectorPaths: Record<string, "procedure" | "address"> = {
    function_not_found: "procedure",
    function_ambiguous: "procedure",
    invalid_address: "address",
  };
  const path = selectorPaths[cause.code];
  if (path === undefined)
    return new ProviderAdapterError(
      BINARY_NINJA_HEADLESS_PROVIDER_IDENTITY.id,
      operation,
      {
        cause,
        userMessage: cause.message,
        diagnostics: { bridge_code: cause.code, bridge_details: cause.details },
      },
    );
  // A provider-derived selector that fails to resolve is a producer fault.
  if (options?.selectorOrigin === "provider")
    return new AnalysisProtocolError(
      `Binary Ninja could not resolve a provider-reported selector: ${cause.message}`,
      { cause, diagnostics: cause.details },
    );
  const selected = cause.details[path];
  return new AnalysisInputError(operation, { cause }, [
    {
      path: [path],
      reason: "invalid_value",
      message:
        typeof selected === "string"
          ? `${cause.message}: ${selected}`
          : cause.message,
    },
  ]);
};

/** Translate validated analyst questions into bridge requests and REA observations. */
export class BinaryNinjaHeadlessOperationRunner {
  constructor(
    private readonly bridge: BinaryNinjaHeadlessBridgeProcess,
    private readonly target: BinaryTarget,
    private readonly regexOptions: BinaryNinjaRegexOptions,
  ) {}

  async run(
    operation: BinaryNinjaHeadlessOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ): Promise<BinaryNinjaOperationOutcome> {
    const signal = options?.signal;
    switch (operation) {
      case "list_documents":
        return { result: [this.target.path] };
      case "list_procedures":
      case "search_procedures":
        return this.#procedures(operation, parameters, signal);
      case "list_strings":
      case "search_strings":
        return this.#strings(operation, parameters, signal);
      case "xrefs":
        return this.#xrefs(parameters, signal);
      case "resolve_containing_procedure":
        return this.#containing(parameters, signal);
      default:
        if (!isFunctionOperation(operation))
          throw new AnalysisProtocolError(
            `Binary Ninja operation ${operation} has no bridge mapping.`,
          );
        return this.#function(operation, parameters, options);
    }
  }

  async #procedures(
    operation: "list_procedures" | "search_procedures",
    parameters: Readonly<Record<string, JsonValue>>,
    signal: AbortSignal | undefined,
  ): Promise<BinaryNinjaOperationOutcome> {
    const raw = await this.bridge.request("functions", {}, signal);
    const items = z
      .array(bridgeFunctionIdentitySchema)
      .parse(raw)
      .map(projectProcedureRow);
    return {
      result:
        operation === "list_procedures"
          ? items
          : await this.#search(operation, parameters, items, signal),
      rawResult: raw,
    };
  }

  async #strings(
    operation: "list_strings" | "search_strings",
    parameters: Readonly<Record<string, JsonValue>>,
    signal: AbortSignal | undefined,
  ): Promise<BinaryNinjaOperationOutcome> {
    const raw = await this.bridge.request(
      "strings",
      operation === "list_strings" && typeof parameters.address === "string"
        ? { address: canonicalAddress(parameters.address) }
        : {},
      signal,
    );
    const rows = z.array(bridgeStringSchema).parse(raw);
    const items = rows.map(projectAnalysisString);
    const undecodable = rows.filter(
      (row) => row.decoding_failure !== undefined,
    ).length;
    return {
      result:
        operation === "list_strings"
          ? items
          : await this.#search(operation, parameters, items, signal),
      rawResult: raw,
      limitations:
        undecodable === 0
          ? []
          : [
              `${String(undecodable)} strings could not be decoded from their Binary Ninja string type and retain a Latin-1 rendering with an explicit decoding unknown.`,
            ],
    };
  }

  async #xrefs(
    parameters: Readonly<Record<string, JsonValue>>,
    signal: AbortSignal | undefined,
  ): Promise<BinaryNinjaOperationOutcome> {
    const address = canonicalAddress(String(parameters.address));
    const raw = await this.bridge.request("xrefs", { address }, signal);
    const xrefs = bridgeXrefsSchema.parse(raw);
    const sources = [
      ...new Set([
        ...xrefs.code.map((reference) => reference.address),
        ...xrefs.data,
      ]),
    ].sort(compareAddresses);
    return {
      result: sources,
      rawResult: raw,
      locations: [{ kind: "address", address }],
    };
  }

  async #containing(
    parameters: Readonly<Record<string, JsonValue>>,
    signal: AbortSignal | undefined,
  ): Promise<BinaryNinjaOperationOutcome> {
    const address = canonicalAddress(String(parameters.address));
    const raw = await this.bridge.request("containing", { address }, signal);
    const containing = bridgeContainingSchema.parse(raw);
    return {
      result: projectContainingProcedure(containing),
      rawResult: raw,
      locations: [{ kind: "address", address }],
      ...(containing.functions.length > 1
        ? {
            limitations: [
              `${String(containing.functions.length)} Binary Ninja functions contain this address; the lowest entry is reported.`,
            ],
          }
        : {}),
    };
  }

  async #function(
    operation: FunctionOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ): Promise<BinaryNinjaOperationOutcome> {
    const raw = await this.bridge.request(
      "function",
      {
        procedure: String(parameters.procedure),
        facets: [...FUNCTION_FACETS[operation]],
      },
      options?.signal,
    );
    const result = bridgeFunctionResultSchema.parse(raw);
    const locations: EvidenceLocation[] = [
      { kind: "address", address: result.procedure.address },
    ];
    const limitations = binaryNinjaHeadlessLimitationsFor(operation);
    switch (operation) {
      case "procedure_address":
        return { result: result.procedure.address, rawResult: raw, locations };
      case "procedure_pseudo_code":
        return {
          result: (result.pseudocode ?? []).join("\n"),
          rawResult: raw,
          locations,
        };
      case "procedure_assembly":
        return {
          result: (result.assembly ?? []).map(formatInstruction).join("\n"),
          rawResult: raw,
          locations,
        };
      case "read_function_instructions":
        return {
          result: projectInstructionWindow(result, limitations),
          rawResult: raw,
          locations,
        };
      case "procedure_callers":
        return {
          result: (result.callers ?? []).map(
            (caller) => caller.procedure.address,
          ),
          rawResult: raw,
          locations,
          relationshipCoverage: callerCoverage(),
        };
      case "procedure_callees": {
        const coverage = calleeCoverage(result);
        return {
          result: (result.callees?.resolved ?? []).map(
            (callee) =>
              callee.target.procedure?.address ??
              callee.target.address ??
              "0x0",
          ),
          rawResult: raw,
          locations,
          relationshipCoverage: coverage,
          ...(coverage.status === "partial"
            ? { limitations: coverage.limitations }
            : {}),
        };
      }
      case "analyze_function": {
        const coverage = combineFunctionRelationshipCoverage(
          callerCoverage(),
          calleeCoverage(result),
        );
        return {
          result: projectFunctionDossier(result, [
            ...limitations,
            ...(coverage.status === "partial"
              ? coverage.limitations
              : coverage.status === "unknown"
                ? [coverage.reason]
                : []),
          ]),
          rawResult: raw,
          locations,
          relationshipCoverage: coverage,
        };
      }
    }
  }

  async #search<T extends { readonly value: string }>(
    operation: "search_procedures" | "search_strings",
    parameters: Readonly<Record<string, JsonValue>>,
    items: readonly T[],
    signal: AbortSignal | undefined,
  ): Promise<T[]> {
    const query = analysisSearchQuerySchema.parse(parameters);
    if (query.mode === "literal") {
      const matches = analysisSearchPredicate(query);
      return items.filter(({ value }) => matches(value));
    }
    const matched = await matchRegexValues({
      operation,
      pattern: query.pattern,
      caseSensitive: query.case_sensitive,
      values: items.map(({ value }) => value),
      signal,
      deadline: this.regexOptions.regexMatchingDeadline,
      heapRequest: this.regexOptions.regexWorkerHeapRequest,
    });
    if (!matched.ok) throw matched.error;
    return matched.value.map((index) => items[index]!);
  }
}
