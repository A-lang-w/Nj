import { stat } from "node:fs/promises";

import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import {
  summarizeEnvironmentCoverage,
  type EnvironmentCoverage,
} from "../../domain/analysisView/environmentCoverageView.js";
import {
  TEMPLATE_RULES,
  type TemplateRule,
} from "../../domain/analysisView/environmentManifestRules.js";
import type { Evidence } from "../../domain/evidence.js";
import {
  bufferedJsonParts,
  jsonParts,
} from "../../domain/jsonSerialization.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import { inspectAnalysisView } from "../analysisView/AnalysisViewService.js";
import {
  ENVIRONMENT_EXPORT_OPERATION,
  planEnvironmentBundle,
  registryPackageSource,
  type EnvironmentPackageSource,
} from "./environmentBundle.js";
import {
  anonymousOrigin,
  nameFromCaptureFile,
  scanCredentialNames,
  type EnvironmentBuildWarning,
} from "./environmentBuildReport.js";
import {
  environmentExportFile,
  exportEnvironmentBundle,
  type EnvironmentExportFile,
  type WrittenBundleFile,
} from "./environmentExport.js";
import {
  loadEnvironmentSource,
  parseCaptureEvidence,
  parseEvidenceFile,
} from "./environmentSource.js";
import { prepareServedState, type PreparedState } from "./environmentState.js";

/** Operation name the build command's own refusals report; each stage keeps its own. */
export const ENVIRONMENT_BUILD_OPERATION = "environment-build";

/** The opt-in rules the rebuild pipeline selects for every published capture-built environment. */
export const DEFAULT_BUILD_TEMPLATE_RULES: readonly TemplateRule[] = [
  "after-uid-literal",
  "opaque-token",
  "sibling-variance",
  "prefix-variance",
];

/** What the capture argument is, decided from its file name before anything is read. */
export type EnvironmentBuildCaptureInput = "har" | "evidence";

/** A HAR file is inspected; a JSON file must already be capture Evidence. */
export const classifyBuildCapture = (
  path: string,
): Result<EnvironmentBuildCaptureInput, AnalysisInputError> => {
  if (/\.har$/iu.test(path)) return ok("har");
  if (/\.json$/iu.test(path)) return ok("evidence");
  return err(
    new AnalysisInputError(
      ENVIRONMENT_BUILD_OPERATION,
      {
        userMessage: `${path} is neither a .har capture nor a .json capture Evidence file.`,
      },
      [
        {
          path: ["capture"],
          reason: "invalid_value",
          expected: ".har or .json",
          message:
            "Pass a HAR file, or capture Evidence JSON from inspect-web-network-capture (HAR) or capture-browser-scenario.",
        },
      ],
    ),
  );
};

/** An Evidence file's bytes as `--format json` writes the Evidence to a file: compact JSON and a newline. */
export const evidenceFileBytes = (evidence: Evidence): Buffer =>
  Buffer.concat([
    ...Array.from(bufferedJsonParts(jsonParts(evidence)), (part) =>
      Buffer.from(part),
    ),
    Buffer.from("\n"),
  ]);

/** Rules in the views' fixed order, so the report and manifest list them canonically. */
export const canonicalTemplateRules = (
  rules: readonly TemplateRule[],
): TemplateRule[] => TEMPLATE_RULES.filter((rule) => rules.includes(rule));

export interface EnvironmentBuildInput {
  /** The capture Evidence the bundle ships, read or serialized once. */
  readonly capture: EnvironmentExportFile;
  readonly captureInput: EnvironmentBuildCaptureInput;
  /** The capture argument, absolute; names a loopback capture's environment. */
  readonly capturePath: string;
  readonly templateRules: readonly TemplateRule[];
  /** Absolute bundle root, absent or empty; may be absent only for a dry run. */
  readonly directory?: string | undefined;
  readonly name?: string | undefined;
  readonly packageTarball?: string | undefined;
  readonly dryRun: boolean;
  /** Called as each stage starts. */
  readonly progress?: ((stage: string) => void) | undefined;
}

export interface EnvironmentBuildReport {
  readonly status: "built" | "planned";
  readonly directory: string | null;
  readonly name: string;
  readonly capture: {
    readonly evidence_id: string;
    readonly operation: string;
    readonly records: number;
    readonly input: EnvironmentBuildCaptureInput;
  };
  readonly manifest: {
    readonly evidence_id: string;
    readonly tools: number;
    readonly excluded_groups: number;
    readonly template_rules: readonly TemplateRule[];
  };
  readonly state: PreparedState["report"];
  /** Null when the state is unavailable and the bundle serves replay. */
  readonly coverage: EnvironmentCoverage | null;
  readonly tool_count: number;
  readonly package_source: JsonValue;
  readonly files: readonly WrittenBundleFile[];
  readonly warnings: readonly EnvironmentBuildWarning[];
  readonly next: readonly string[];
}

const captureOperations = new Set([
  "inspect_web_network_capture",
  "capture_browser_scenario",
]);

const notCaptureEvidence = (operation: string): AnalysisInputError =>
  new AnalysisInputError(
    ENVIRONMENT_BUILD_OPERATION,
    {
      userMessage: `The capture file is ${operation} Evidence, not capture Evidence.`,
    },
    [
      {
        path: ["capture", "operation"],
        reason: "invalid_value",
        expected: "inspect_web_network_capture or capture_browser_scenario",
        message:
          "Pass a HAR file, or capture Evidence JSON from inspect-web-network-capture (HAR) or capture-browser-scenario.",
      },
    ],
  );

const unnamed = (path: string): AnalysisInputError =>
  new AnalysisInputError(
    ENVIRONMENT_BUILD_OPERATION,
    {
      userMessage: `The capture's origin is a loopback or IP address and ${path} yields no name; pass --name.`,
    },
    [
      {
        path: ["name"],
        reason: "invalid_value",
        message:
          "Name the environment with --name: a kebab-case label of lowercase letters, digits and single hyphens.",
      },
    ],
  );

const missingDirectory = (): AnalysisInputError =>
  new AnalysisInputError(
    ENVIRONMENT_BUILD_OPERATION,
    { userMessage: "Name the bundle directory, or pass --dry-run." },
    [
      {
        path: ["directory"],
        reason: "invalid_value",
        message: "The bundle directory may be omitted only with --dry-run.",
      },
    ],
  );

/** The given name; else the manifest's, unless its origin is anonymous, when the capture file names it. */
const environmentName = (
  input: EnvironmentBuildInput,
  manifest: { readonly name: string; readonly origin: string },
  warnings: EnvironmentBuildWarning[],
): Result<string | undefined, AnalysisInputError> => {
  if (input.name !== undefined) return ok(input.name);
  if (!anonymousOrigin(manifest.origin)) return ok(undefined);
  const name = nameFromCaptureFile(input.capturePath);
  if (name === "") return err(unnamed(input.capturePath));
  warnings.push({
    code: "name-from-file",
    message: `The capture's origin ${manifest.origin} names no application, so the environment is named ${name} after the capture file; pass --name to choose another.`,
  });
  return ok(name);
};

const packageSourceValue = (source: EnvironmentPackageSource): JsonValue =>
  source.kind === "registry"
    ? { kind: "registry", specifier: source.specifier }
    : { kind: "tarball", path: source.path };

const tarballBytes = async (
  path: string,
): Promise<Result<number, AnalysisInputError>> => {
  try {
    const found = await stat(path);
    if (found.isFile()) return ok(found.size);
  } catch {
    // Reported below as the same refusal a build gives.
  }
  return err(
    new AnalysisInputError(
      ENVIRONMENT_EXPORT_OPERATION,
      { userMessage: `${path} must name a readable regular package tarball.` },
      [
        {
          path: ["package_tarball"],
          reason: "invalid_value",
          message: "The package tarball must be an existing regular file.",
        },
      ],
    ),
  );
};

/**
 * Build an agent environment bundle from capture Evidence: project the
 * manifest from the in-memory capture, authenticate the pair, prepare the
 * state the bundle's server derives and summarize what it serves, then write
 * the bundle with the export unless this is a dry run. Every file equals what
 * inspect-analysis-view and environment-export produce from the same capture.
 */
export const buildEnvironment = async (
  input: EnvironmentBuildInput,
): Promise<Result<EnvironmentBuildReport, AnalysisError>> => {
  if (input.directory === undefined && !input.dryRun)
    return err(missingDirectory());
  const evidence = parseEvidenceFile(
    ENVIRONMENT_BUILD_OPERATION,
    "evidence",
    input.capture.value,
  );
  if (!evidence.ok) return evidence;
  if (!captureOperations.has(evidence.value.operation))
    return err(notCaptureEvidence(evidence.value.operation));
  const capture = evidence.value;
  const templateRules = canonicalTemplateRules(input.templateRules);
  input.progress?.("manifest");
  const projected = await inspectAnalysisView(
    {
      source: { kind: "retained-evidence", evidence_id: capture.evidence_id },
      view: { kind: "environment-manifest", template_rules: templateRules },
    },
    (id) => (id === capture.evidence_id ? capture : undefined),
  );
  if (!projected.ok) return projected;
  const manifest = await environmentExportFile(
    "manifest",
    "manifest.json",
    evidenceFileBytes(projected.value),
    ENVIRONMENT_BUILD_OPERATION,
  );
  if (!manifest.ok) return manifest;
  const source = loadEnvironmentSource(
    manifest.value.value,
    input.capture.value,
    ENVIRONMENT_BUILD_OPERATION,
  );
  if (!source.ok) return source;
  const warnings: EnvironmentBuildWarning[] = [];
  const named = environmentName(input, source.value.manifest, warnings);
  if (!named.ok) return named;
  const name = named.value ?? source.value.manifest.name;
  input.progress?.("state");
  // Prepared as the export prepares it, so its report and the bundle's README match the three-step path.
  const served = prepareServedState(source.value, input.capture.value, {
    name,
    operation: ENVIRONMENT_EXPORT_OPERATION,
  });
  const records = parseCaptureEvidence(
    ENVIRONMENT_BUILD_OPERATION,
    input.capture.value,
    "manifest",
  );
  if (!records.ok) return records;
  const scanned = scanCredentialNames(records.value.records);
  if (scanned.count > 0)
    warnings.push({
      code: "credential-named-members",
      message: `${String(scanned.count)} recorded body members have credential-like names and a value; evidence.json ships them, so review it before sharing.`,
      pointers: scanned.pointers,
    });
  const packageSource: EnvironmentPackageSource =
    input.packageTarball === undefined
      ? registryPackageSource()
      : { kind: "tarball", path: input.packageTarball };
  const base = {
    name,
    capture: {
      evidence_id: capture.evidence_id,
      operation: capture.operation,
      records: records.value.records.length,
      input: input.captureInput,
    },
    manifest: {
      evidence_id: source.value.manifestEvidenceId,
      tools: source.value.manifest.tools.length,
      excluded_groups: source.value.manifest.excluded.length,
      template_rules: templateRules,
    },
    state: served.report,
    coverage:
      served.state === undefined
        ? null
        : summarizeEnvironmentCoverage({
            views: served.state.views.values(),
            writes: served.state.writes.values(),
          }),
    warnings,
  };
  if (input.dryRun) {
    const plan = planEnvironmentBundle(source.value, {
      name,
      packageSource,
      served: () => served,
    });
    if (!plan.ok) return plan;
    const files: WrittenBundleFile[] = [
      ...plan.value.files.map((file) => ({
        path: file.path,
        bytes: Buffer.byteLength(file.content),
      })),
      { path: plan.value.copies.manifest, bytes: manifest.value.bytes.length },
      { path: plan.value.copies.evidence, bytes: input.capture.bytes.length },
    ];
    if (
      plan.value.copies.tarball !== null &&
      input.packageTarball !== undefined
    ) {
      const bytes = await tarballBytes(input.packageTarball);
      if (!bytes.ok) return bytes;
      files.push({ path: plan.value.copies.tarball, bytes: bytes.value });
    }
    return ok({
      status: "planned",
      directory: input.directory ?? null,
      ...base,
      tool_count: plan.value.toolCount,
      package_source: packageSourceValue(packageSource),
      files,
      next: [],
    });
  }
  const directory = input.directory;
  if (directory === undefined) return err(missingDirectory());
  input.progress?.("bundle");
  const exported = await exportEnvironmentBundle({
    manifest: manifest.value,
    evidence: input.capture,
    source: source.value,
    served,
    directory,
    name,
    packageTarball: input.packageTarball,
  });
  if (!exported.ok) return exported;
  return ok({
    status: "built",
    directory,
    ...base,
    tool_count: exported.value.tool_count,
    package_source: exported.value.package_source,
    files: exported.value.files,
    next: [`agent-env run ${directory}`],
  });
};
