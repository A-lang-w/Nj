import { z } from "zod";

import {
  functionDossierSchema,
  functionInstructionWindowSchema,
  type ContainingProcedureResolution,
} from "../domain/hopperValues.js";
import { jsonObjectSchema, jsonValueSchema } from "../domain/jsonValue.js";

/** Canonical lowercase address text the bridge emits for every coordinate. */
export const bridgeAddressSchema = z.string().regex(/^0x[0-9a-f]+$/u);

/** Facts the bridge reports once its interpreter imported the Binary Ninja API. */
export const bridgeReadyFrameSchema = z.object({
  event: z.literal("ready"),
  core_version: z.string().min(1),
  build_id: z.number(),
  product: z.string(),
  product_type: z.string(),
  license_count: z.number(),
  ui_enabled: z.boolean(),
  python_version: z.string(),
  api_dir: z.string(),
  user_plugins_disabled: z.boolean(),
  user_settings_disabled: z.boolean(),
  pid: z.number(),
});
export type BinaryNinjaBridgeReadyFrame = z.infer<
  typeof bridgeReadyFrameSchema
>;

/** The interpreter started but the Binary Ninja API could not be imported. */
export const bridgeFatalFrameSchema = z.object({
  event: z.literal("fatal"),
  code: z.string(),
  message: z.string(),
  api_dir: z.string().optional(),
});

export const bridgeReplySchema = z.discriminatedUnion("ok", [
  z.object({
    id: z.number().int().nullable(),
    ok: z.literal(true),
    result: jsonValueSchema,
  }),
  z.object({
    id: z.number().int().nullable(),
    ok: z.literal(false),
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: jsonObjectSchema.optional(),
    }),
  }),
]);

/** Every line the bridge writes to stdout. */
export const bridgeFrameSchema = z.union([
  bridgeReadyFrameSchema,
  bridgeFatalFrameSchema,
  bridgeReplySchema,
]);

const bridgeSymbolSchema = z.object({
  type: z.string(),
  auto: z.boolean(),
  source: z.enum(["default", "analysis", "imported", "user_defined"]),
  external: z.boolean(),
  short_name: z.string(),
  full_name: z.string(),
  raw_name: z.string(),
});

const bridgeBodySchema = z.object({
  ranges: z.array(
    z.object({ start: bridgeAddressSchema, end: bridgeAddressSchema }),
  ),
  total_bytes: z.int().min(0),
  span_bytes: z.int().min(0),
  contains_entry: z.boolean(),
});

/** One function as the bridge reports it; projections below shape it for REA. */
export const bridgeFunctionIdentitySchema = z.object({
  address: bridgeAddressSchema,
  name: z.string(),
  symbol: bridgeSymbolSchema.nullable(),
  thunk: z.boolean(),
  thunk_target: bridgeAddressSchema.nullable(),
  external: z.boolean(),
  body: bridgeBodySchema,
});
export type BinaryNinjaBridgeFunctionIdentity = z.infer<
  typeof bridgeFunctionIdentitySchema
>;

export const bridgeOverviewSchema = z.object({
  path: z.string(),
  view_type: z.string(),
  architecture: z.string().nullable(),
  platform: z.string().nullable(),
  entry_point: bridgeAddressSchema,
  start: bridgeAddressSchema,
  end: bridgeAddressSchema,
  length: z.int().min(0),
  address_size: z.int().min(0),
  endianness: z.string(),
  analysis_state: z.string(),
  function_count: z.int().min(0),
  string_count: z.int().min(0),
  segment_count: z.int().min(0),
  has_symbols: z.boolean(),
  relocatable: z.boolean(),
  core_version: z.string(),
  load_and_analysis_ms: z.int().min(0).optional(),
});
export type BinaryNinjaBridgeOverview = z.infer<typeof bridgeOverviewSchema>;

export const bridgeHealthSchema = z.object({
  open: z.boolean(),
  core_version: z.string(),
  analysis_state: z.string().optional(),
  path: z.string().optional(),
});

export const bridgeStringSchema = z.object({
  address: bridgeAddressSchema,
  type: z.string(),
  encoding: z.string().nullable(),
  byte_length: z.int().min(0),
  value: z.string(),
  decoding_failure: z.string().optional(),
  source_address: bridgeAddressSchema.optional(),
});
export type BinaryNinjaBridgeString = z.infer<typeof bridgeStringSchema>;

export const bridgeXrefsSchema = z.object({
  address: bridgeAddressSchema,
  code: z.array(
    z.object({
      address: bridgeAddressSchema,
      function: bridgeAddressSchema.nullable(),
    }),
  ),
  data: z.array(bridgeAddressSchema),
});

export const bridgeContainingSchema = z.object({
  address: bridgeAddressSchema,
  in_segment: z.boolean(),
  functions: z.array(bridgeFunctionIdentitySchema),
});

const bridgeCalleeTargetSchema = z.object({
  kind: z.enum(["function", "symbol", "address"]),
  procedure: bridgeFunctionIdentitySchema.optional(),
  address: bridgeAddressSchema.optional(),
  name: z.string().nullable().optional(),
  symbol: bridgeSymbolSchema.nullable().optional(),
});

const bridgeReferenceEdgeSchema = z.object({
  source: bridgeAddressSchema,
  target: bridgeAddressSchema,
  category: z.enum(["code", "call", "data"]),
  source_function: bridgeFunctionIdentitySchema.nullable(),
  target_function: bridgeFunctionIdentitySchema.nullable(),
});

/** Function facets; each is present only when the request named it. */
export const bridgeFunctionResultSchema = z.object({
  procedure: bridgeFunctionIdentitySchema,
  signature: z.string().nullable().optional(),
  pseudocode: z.array(z.string()).optional(),
  assembly: z
    .array(z.object({ address: bridgeAddressSchema, text: z.string() }))
    .optional(),
  callers: z
    .array(
      z.object({
        procedure: bridgeFunctionIdentitySchema,
        sites: z.array(bridgeAddressSchema),
      }),
    )
    .optional(),
  callees: z
    .object({
      resolved: z.array(
        z.object({
          target: bridgeCalleeTargetSchema,
          sites: z.array(bridgeAddressSchema),
        }),
      ),
      unresolved_sites: z.array(bridgeAddressSchema),
    })
    .optional(),
  basic_blocks: z
    .array(
      z.object({
        start: bridgeAddressSchema,
        end: bridgeAddressSchema,
        successors: z.array(bridgeAddressSchema),
      }),
    )
    .optional(),
  locals: z
    .array(
      z.object({
        name: z.string(),
        type: z.string(),
        source_type: z.string(),
        storage: z.int(),
      }),
    )
    .optional(),
  comments: z
    .array(z.object({ address: bridgeAddressSchema, text: z.string() }))
    .optional(),
  incoming_references: z.array(bridgeReferenceEdgeSchema).optional(),
  outgoing_references: z.array(bridgeReferenceEdgeSchema).optional(),
  referenced_strings: z.array(bridgeStringSchema).optional(),
  referenced_names: z
    .array(
      z.object({
        address: bridgeAddressSchema,
        value: z.string(),
        source_address: bridgeAddressSchema,
      }),
    )
    .optional(),
});
export type BinaryNinjaBridgeFunctionResult = z.infer<
  typeof bridgeFunctionResultSchema
>;

const CLASSIFICATION_PROVENANCE = "binaryninja-function";
const BODY_PROVENANCE = "binaryninja-function-address-ranges";
const SYMBOL_BODY_REASON =
  "An import slot or data symbol has no function body in Binary Ninja.";

const projectSymbol = (symbol: z.infer<typeof bridgeSymbolSchema> | null) =>
  symbol === null
    ? null
    : {
        primary: true,
        dynamic: false,
        external: symbol.external,
        type: symbol.type,
        source: symbol.source,
      };

/** Shared REA procedure identity with complete inclusive body ranges. */
export const projectProcedureIdentity = (
  identity: BinaryNinjaBridgeFunctionIdentity,
) => ({
  address: identity.address,
  name: identity.name,
  symbol: projectSymbol(identity.symbol),
  classification: {
    external: identity.external,
    thunk: identity.thunk,
    thunk_target: identity.thunk_target,
    provenance: CLASSIFICATION_PROVENANCE,
  },
  body: {
    available: true as const,
    provenance: BODY_PROVENANCE,
    ranges: identity.body.ranges.map(({ start, end }) => ({ start, end })),
    total_bytes: identity.body.total_bytes,
    span_bytes: identity.body.span_bytes,
    non_contiguous: identity.body.ranges.length > 1,
    contains_entry: identity.body.contains_entry,
  },
});

/** A resolved call target that is a symbol or bare address rather than a function. */
const projectCalleeTarget = (
  target: z.infer<typeof bridgeCalleeTargetSchema>,
) => {
  if (target.kind === "function" && target.procedure !== undefined)
    return projectProcedureIdentity(target.procedure);
  const address = target.address ?? "0x0";
  return {
    address,
    name: target.name ?? address,
    symbol: projectSymbol(target.symbol ?? null),
    classification: {
      external: target.symbol?.external ?? false,
      thunk: false,
      thunk_target: null,
      provenance:
        target.kind === "symbol"
          ? "binaryninja-symbol"
          : "binaryninja-call-target",
    },
    body: { available: false as const, reason: SYMBOL_BODY_REASON },
  };
};

/** Procedure inventory row shared by list and search operations. */
export const projectProcedureRow = (
  identity: BinaryNinjaBridgeFunctionIdentity,
) => {
  const symbol = projectSymbol(identity.symbol);
  return {
    address: identity.address,
    value: identity.name,
    ...(symbol === null ? {} : { symbol }),
    procedure: {
      external: identity.external,
      thunk: identity.thunk,
      thunk_target: identity.thunk_target,
    },
  };
};

/** Typed string evidence; an undecodable value keeps its Latin-1 rendering explicit. */
export const projectAnalysisString = (item: BinaryNinjaBridgeString) => ({
  address: item.address,
  value: item.value,
  ...(item.decoding_failure === undefined
    ? {}
    : {
        decoding: {
          available: false as const,
          reason: `Binary Ninja could not decode the ${item.type} bytes (${item.decoding_failure}); value is a Latin-1 rendering of the raw bytes.`,
        },
      }),
  ...(item.encoding === null
    ? {}
    : {
        string: {
          encoding: item.encoding,
          encoding_status: "observed" as const,
          termination: "present_or_not_required" as const,
          byte_length: item.byte_length,
        },
      }),
});

export const formatInstruction = (instruction: {
  readonly address: string;
  readonly text: string;
}): string => `${instruction.address}: ${instruction.text}`;

/** Lowest-entry containing function wins; absence distinguishes segments from gaps. */
export const projectContainingProcedure = (
  result: z.infer<typeof bridgeContainingSchema>,
): ContainingProcedureResolution => {
  const [first] = result.functions;
  if (first !== undefined)
    return {
      query_address: result.address,
      found: true,
      procedure: projectProcedureIdentity(first),
    };
  return {
    query_address: result.address,
    found: false,
    procedure: null,
    reason: result.in_segment ? "not_in_procedure" : "outside_segments",
  };
};

const projectEdge = (edge: z.infer<typeof bridgeReferenceEdgeSchema>) => ({
  source_address: edge.source,
  target_address: edge.target,
  source_procedure:
    edge.source_function === null
      ? null
      : projectProcedureIdentity(edge.source_function),
  target_procedure:
    edge.target_function === null
      ? null
      : projectProcedureIdentity(edge.target_function),
  kind: {
    available: false as const,
    reason: `Binary Ninja reports this ${edge.category} reference's endpoints without typed reference flags.`,
  },
});

/** Complete raw-instruction list for one function. */
export const projectInstructionWindow = (
  result: BinaryNinjaBridgeFunctionResult,
  limitations: readonly string[],
) =>
  functionInstructionWindowSchema.parse({
    procedure: projectProcedureIdentity(result.procedure),
    instructions: (result.assembly ?? []).map(formatInstruction),
    limitations: [...limitations],
  });

/** Strict shared dossier built from every requested facet. */
export const projectFunctionDossier = (
  result: BinaryNinjaBridgeFunctionResult,
  limitations: readonly string[],
) => {
  const callees = result.callees ?? { resolved: [], unresolved_sites: [] };
  return functionDossierSchema.parse({
    procedure: {
      ...projectProcedureIdentity(result.procedure),
      signature: result.signature ?? null,
      locals: (result.locals ?? []).map((variable) => ({
        description: `${variable.type} ${variable.name}`,
        provenance: "binaryninja-function-variables",
        name: variable.name,
        ...(variable.source_type === "StackVariableSourceType"
          ? { stack_displacement: String(variable.storage) }
          : {}),
      })),
    },
    pseudocode: (result.pseudocode ?? []).join("\n"),
    assembly: (result.assembly ?? []).map(formatInstruction),
    comments: (result.comments ?? []).map((comment) => ({
      address: comment.address,
      kind: "comment",
      text: comment.text,
    })),
    callers: (result.callers ?? []).map((caller) =>
      projectProcedureIdentity(caller.procedure),
    ),
    callees: callees.resolved.map((callee) =>
      projectCalleeTarget(callee.target),
    ),
    incoming_references: (result.incoming_references ?? []).map(projectEdge),
    outgoing_references: (result.outgoing_references ?? []).map(projectEdge),
    unresolved_calls: callees.unresolved_sites.map((address) => ({
      address,
      reason: "Binary Ninja resolved no target for this call site.",
    })),
    referenced_strings: (result.referenced_strings ?? []).map((item) => ({
      ...projectAnalysisString(item),
      source_address: item.source_address ?? result.procedure.address,
    })),
    referenced_names: result.referenced_names ?? [],
    basic_blocks: (result.basic_blocks ?? []).map((block) => ({
      start: block.start,
      end: block.end,
      successors: [...block.successors],
    })),
    native_api: null,
    native_value_flow: null,
    facet_availability: {
      pseudocode: { available: true },
      assembly: { available: true },
      comments: { available: true },
      callers: { available: true },
      callees: { available: true },
      references: { available: true },
      strings_names: { available: true },
      cfg: { available: true },
    },
    limitations: [...limitations],
  });
};
