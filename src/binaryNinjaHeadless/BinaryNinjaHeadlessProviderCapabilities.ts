import type {
  AnalysisOperation,
  CapabilityDescriptor,
  ProviderIdentity,
} from "../application/AnalysisProvider.js";

/** This version identifies REA's adapter; the Binary Ninja core version is observed per session. */
export const BINARY_NINJA_HEADLESS_PROVIDER_IDENTITY: ProviderIdentity =
  Object.freeze({
    id: "binary-ninja-headless",
    name: "Binary Ninja headless adapter",
    version: "1",
  });

/** Read-only analyst outcomes served by REA's owned headless Binary Ninja bridge. */
export const BINARY_NINJA_HEADLESS_OPERATIONS = Object.freeze([
  "list_documents",
  "list_procedures",
  "search_procedures",
  "list_strings",
  "search_strings",
  "procedure_address",
  "procedure_pseudo_code",
  "procedure_assembly",
  "procedure_callers",
  "procedure_callees",
  "read_function_instructions",
  "xrefs",
  "resolve_containing_procedure",
  "analyze_function",
] as const satisfies readonly Exclude<AnalysisOperation, "health">[]);
export type BinaryNinjaHeadlessOperation =
  (typeof BINARY_NINJA_HEADLESS_OPERATIONS)[number];

const operationSet: ReadonlySet<string> = new Set(
  BINARY_NINJA_HEADLESS_OPERATIONS,
);

/** Narrow an application operation to this adapter's advertised surface. */
export const isBinaryNinjaHeadlessOperation = (
  operation: string,
): operation is BinaryNinjaHeadlessOperation => operationSet.has(operation);

/** Shared limitations of observations from an owned headless analysis. */
export const BINARY_NINJA_HEADLESS_LIMITATIONS = Object.freeze([
  "Provider version identifies the REA Binary Ninja headless adapter. The Binary Ninja core version is observed when the owned interpreter starts and is reported in raw results and health output, not committed in the analysis profile.",
  "REA starts an owned headless Binary Ninja Python interpreter with user plugins, repository plugins and user settings disabled, loads the admitted file read-only after verifying its Raw view digest, and waits for default auto-analysis. No Binary Ninja database is created or saved.",
  "Results are live observations of that owned analysis and are never replayed from analysis snapshots.",
  "Caller cancellation and the startup deadline stop the owned interpreter; the next request starts a fresh load and analysis.",
  "Binary Ninja requires a license edition that permits headless use. REA neither checks nor changes licensing; an engine that refuses headless use fails closed with its own error.",
]);

const PSEUDO_C_LIMITATION =
  "Pseudocode is Binary Ninja's Pseudo C language representation of the function, not original source and not text-equivalent to other providers.";
const STRING_LIMITATION =
  "Strings are Binary Ninja's detected string references with its reported string type and byte length; undefined or packed literals may be absent, and an empty search does not establish that text is absent from the artifact.";
const NAME_LIMITATION =
  "Names match exactly against Binary Ninja short, full and raw symbol names; sub_ default names are reported with default symbol source. Thunk targets are derived only when a thunk has exactly one callee.";

/** Limitation text for one advertised operation, including the shared base. */
export const binaryNinjaHeadlessLimitationsFor = (
  operation: string,
): readonly string[] => {
  const common = [...BINARY_NINJA_HEADLESS_LIMITATIONS];
  switch (operation) {
    case "list_procedures":
    case "search_procedures":
    case "procedure_address":
      return [...common, NAME_LIMITATION];
    case "list_strings":
    case "search_strings":
      return [...common, STRING_LIMITATION];
    case "procedure_pseudo_code":
      return [...common, PSEUDO_C_LIMITATION];
    case "procedure_assembly":
    case "read_function_instructions":
      return [
        ...common,
        "Instruction text is Binary Ninja disassembly without variable annotations and does not claim textual equivalence with other providers.",
      ];
    case "procedure_callers":
      return [
        ...common,
        "Callers are functions that contain resolved direct call sites into this function; unresolved indirect calls elsewhere in the program remain unknown.",
      ];
    case "procedure_callees":
      return [
        ...common,
        "Callees are resolved direct call targets, including import slots named by their symbol. Call sites without a resolved target are reported as partial coverage.",
      ];
    case "xrefs":
      return [
        ...common,
        "Address references combine Binary Ninja code references and data references to the exact address; references through unresolved indirect flow remain unknown.",
      ];
    case "resolve_containing_procedure":
      return [
        ...common,
        "Containment uses Binary Ninja function address ranges and segment membership; overlapping functions resolve to the lowest entry address.",
      ];
    case "analyze_function":
      return [
        ...common,
        PSEUDO_C_LIMITATION,
        NAME_LIMITATION,
        STRING_LIMITATION,
        "Incoming references are observed at the function entry and basic-block starts; references into instruction interiors are not enumerated. Reference edges carry Binary Ninja's code, call or data category but no typed reference flags.",
        "Basic-block end addresses are inclusive; successors are the block's outgoing edge targets.",
      ];
    default:
      return common;
  }
};

/** Advertise live owned-process observations and their effects truthfully. */
export const binaryNinjaHeadlessCapabilities =
  (): readonly CapabilityDescriptor[] =>
    Object.freeze(
      BINARY_NINJA_HEADLESS_OPERATIONS.map((operation) =>
        Object.freeze({
          provider: BINARY_NINJA_HEADLESS_PROVIDER_IDENTITY,
          operation,
          available: true as const,
          reason: null,
          cachePolicy: "live" as const,
          effects: Object.freeze({
            mutatesArtifact: false,
            launchesProcess: true,
            mayShowUi: false,
            mayAccessNetwork: false,
            // Binary Ninja maintains its own user directory when it starts.
            mayWriteFilesystem: true,
            changesPermissions: false,
            requiresRoot: false,
          }),
          limitations: Object.freeze(
            binaryNinjaHeadlessLimitationsFor(operation),
          ),
        }),
      ),
    );
