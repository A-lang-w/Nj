import type {
  NativeMetadataEvidence,
  NativeMetadataLocation,
  ObjcSwiftMetadata,
} from "../domain/native/objcSwiftMetadata.js";
import { issue, type FacetDecodeFacts } from "./AppleDispatchDecodeFacts.js";
import {
  unresolvedSwiftRelativeReason,
  type SwiftRelativeField,
  type SwiftRelativeValue,
} from "./AppleSwiftDispatchFacets.js";
import { expectedSwiftMetadataReadFailure } from "./AppleSwiftMetadataReadFailure.js";

/** Byte readers shared with the validated Mach-O metadata boundary. */
export interface SwiftNominalReaders {
  u32(address: bigint): number;
  relative(address: bigint, kind: SwiftRelativeField): SwiftRelativeValue;
  string(address: bigint): string;
  location(address: bigint): NativeMetadataLocation;
  evidence(address: bigint, description: string): NativeMetadataEvidence[];
  admit(): boolean;
}

/** A `__swift5_types` descriptor whose kind and own name were read. */
export interface SwiftNominalDescriptor {
  readonly record: bigint;
  readonly descriptor: bigint;
  readonly flags: number;
  readonly name: string;
}

/** A `__swift5_types` record whose descriptor kind or name is unknown. */
export interface SwiftNominalRecordFailure {
  readonly record: bigint;
  readonly message: string;
}

export interface SwiftNominalTypes {
  readonly facts: FacetDecodeFacts;
  /** Admitted class, struct and enum descriptors, including partial ones. */
  readonly descriptors: readonly SwiftNominalDescriptor[];
  readonly failures: readonly SwiftNominalRecordFailure[];
}

const FACET = "swift_declarations";
const CLASS = 16;
const STRUCT = 17;
const ENUM = 18;
const MODULE = 0;
const EXTENSION = 1;
const ANONYMOUS = 2;
const GENERIC = 0x80;
const CLASS_IS_ACTOR = 0x80;
/** Swift nesting is shallow; a longer chain is malformed or cyclic. */
const MAXIMUM_CONTEXT_DEPTH = 32;

const hex = (value: bigint) => `0x${value.toString(16)}`;

/** Named path of one context below its module; null when unresolved. */
interface ContextFacts {
  readonly module: string | null;
  readonly path: readonly string[] | null;
  readonly anonymous: boolean;
  readonly reason: string | null;
}

const unresolved = (reason: string): ContextFacts => ({
  module: null,
  path: null,
  anonymous: false,
  reason,
});

/**
 * Decode `__swift5_types` nominal type descriptors into `swift_decls`.
 * Each context is read once, so shared parents add one relative-pointer
 * record regardless of how many types they contain.
 */
export const decodeSwiftNominalTypes = (input: {
  readers: SwiftNominalReaders;
  entries: readonly bigint[];
  result: ObjcSwiftMetadata;
}): SwiftNominalTypes => {
  const { readers: read, result } = input;
  const issues = [] as ReturnType<typeof issue>[];
  const descriptors: SwiftNominalDescriptor[] = [];
  const failures: SwiftNominalRecordFailure[] = [];
  const contexts = new Map<bigint, ContextFacts>();
  const names = new Map<bigint, string>();
  let examined = 0;
  let decoded = 0;

  const typeName = (descriptor: bigint): string => {
    const known = names.get(descriptor);
    if (known !== undefined) return known;
    const value = read.relative(descriptor + 8n, "typeName");
    if (value.kind !== "target")
      throw new RangeError(unresolvedSwiftRelativeReason(value, "typeName"));
    const name = read.string(value.target);
    if (name.length === 0)
      throw new RangeError("Swift type descriptor name is empty");
    names.set(descriptor, name);
    return name;
  };

  const parentOf = (descriptor: bigint, depth: number): ContextFacts => {
    const value = read.relative(descriptor + 4n, "contextParent");
    if (value.kind === "target") return contextOf(value.target, depth + 1);
    return unresolved(
      value.kind === "null"
        ? "Swift context descriptor has no parent module"
        : unresolvedSwiftRelativeReason(value, "contextParent"),
    );
  };

  const readContext = (context: bigint, depth: number): ContextFacts => {
    if (depth > MAXIMUM_CONTEXT_DEPTH)
      return unresolved(
        `Swift context parent chain exceeds ${MAXIMUM_CONTEXT_DEPTH} contexts or is cyclic`,
      );
    const kind = read.u32(context) & 31;
    switch (kind) {
      case MODULE: {
        const value = read.relative(context + 8n, "moduleName");
        if (value.kind !== "target")
          return unresolved(unresolvedSwiftRelativeReason(value, "moduleName"));
        const module = read.string(value.target);
        return module.length === 0
          ? unresolved("Swift module context name is empty")
          : { module, path: [], anonymous: false, reason: null };
      }
      case CLASS:
      case STRUCT:
      case ENUM: {
        const name = typeName(context);
        const parent = parentOf(context, depth);
        return {
          ...parent,
          path: parent.path === null ? null : [...parent.path, name],
        };
      }
      case ANONYMOUS:
        return { ...parentOf(context, depth), anonymous: true };
      case EXTENSION: {
        // The extended type is a mangled name, often in another module, so
        // the declaring module is known but the qualified path is not.
        const parent = parentOf(context, depth);
        return {
          ...parent,
          path: null,
          reason:
            parent.reason ??
            "Swift type is declared in an extension whose extended type is not demangled",
        };
      }
      default:
        return unresolved(`Unsupported Swift context descriptor kind ${kind}`);
    }
  };

  const contextOf = (context: bigint, depth: number): ContextFacts => {
    const known = contexts.get(context);
    if (known !== undefined) return known;
    let facts: ContextFacts;
    try {
      facts = readContext(context, depth);
    } catch (cause) {
      const reason = expectedSwiftMetadataReadFailure(cause);
      if (reason === null) throw cause;
      facts = unresolved(reason);
    }
    contexts.set(context, facts);
    return facts;
  };

  for (const record of input.entries) {
    if (!read.admit()) {
      issues.push(
        issue(
          FACET,
          "record_budget_exhausted",
          "max_records_reached",
          hex(record),
        ),
      );
      break;
    }
    examined++;
    let descriptor: bigint;
    let flags: number;
    let name: string;
    try {
      const value = read.relative(record, "typeMetadataRecord");
      if (value.kind !== "target")
        throw new RangeError(
          unresolvedSwiftRelativeReason(value, "typeMetadataRecord"),
        );
      descriptor = value.target;
      flags = read.u32(descriptor);
      const kind = flags & 31;
      if (kind !== CLASS && kind !== STRUCT && kind !== ENUM) {
        issues.push(
          issue(
            FACET,
            "unsupported_type_descriptor_kind",
            `Unsupported Swift type descriptor kind ${kind}`,
            hex(record),
          ),
        );
        continue;
      }
      name = typeName(descriptor);
    } catch (cause) {
      const message = expectedSwiftMetadataReadFailure(cause);
      if (message === null) throw cause;
      failures.push({ record, message });
      issues.push(issue(FACET, "type_decode_failed", message, hex(record)));
      continue;
    }
    descriptors.push({ record, descriptor, flags, name });
    const context = contextOf(descriptor, 0);
    let accessor: string | null = null;
    let accessorReason: string | null = null;
    try {
      const value = read.relative(descriptor + 12n, "typeAccessFunction");
      if (value.kind === "target") accessor = hex(value.target);
      else if (value.kind !== "null")
        accessorReason = unresolvedSwiftRelativeReason(
          value,
          "typeAccessFunction",
        );
    } catch (cause) {
      accessorReason = expectedSwiftMetadataReadFailure(cause);
      if (accessorReason === null) throw cause;
    }
    const reason = context.reason ?? accessorReason;
    const kind = flags & 31;
    result.swift_decls.push({
      kind:
        kind === STRUCT
          ? "struct"
          : kind === ENUM
            ? "enum"
            : ((flags >>> 16) & CLASS_IS_ACTOR) !== 0
              ? "actor"
              : "class",
      name,
      qualified_name: context.path?.join(".") ?? null,
      module: context.module,
      generic: (flags & GENERIC) !== 0,
      anonymous_context: context.anonymous,
      accessor_address: accessor,
      location: read.location(descriptor),
      decode:
        reason === null
          ? { status: "decoded", reason: null }
          : { status: "partial", reason },
      evidence: read.evidence(
        record,
        "Swift __swift5_types record of the nominal type descriptor at location",
      ),
    });
    if (reason === null) decoded++;
    else
      issues.push(
        issue(FACET, "type_context_unresolved", reason, hex(descriptor)),
      );
  }
  return {
    facts: {
      facet: FACET,
      examined,
      decoded,
      exhaustive: issues.length === 0,
      issues,
    },
    descriptors,
    failures,
  };
};
