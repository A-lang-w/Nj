import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";

import { describe, expect, it } from "vitest";

import {
  analysisViewCaptureEvidence,
  environmentManifestCaptureFixture,
} from "../../../tests/fixtures/analysisView.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { analysisViewRequestSchema } from "../../domain/analysisView/analysisView.js";
import { summarizeEnvironmentCoverage } from "../../domain/analysisView/environmentCoverageView.js";
import type { Evidence } from "../../domain/evidence.js";
import { inspectAnalysisViewValidated } from "../analysisView/AnalysisViewService.js";
import {
  DEFAULT_BUILD_TEMPLATE_RULES,
  buildEnvironment,
  canonicalTemplateRules,
  classifyBuildCapture,
  evidenceFileBytes,
  type EnvironmentBuildInput,
} from "./environmentBuild.js";
import {
  exportEnvironmentBundle,
  readEnvironmentExportFile,
  readEnvironmentExportInputs,
} from "./environmentExport.js";
import { loadEnvironmentSource } from "./environmentSource.js";
import { prepareServedState } from "./environmentState.js";

const listFiles = async (root: string): Promise<string[]> =>
  (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(root.length + 1)
        .split(sep)
        .join("/"),
    )
    .sort();

/** The Grafana-shaped capture with every recorded URL moved to a loopback origin. */
const loopbackCapture = (): Evidence =>
  analysisViewCaptureEvidence(
    JSON.parse(
      JSON.stringify(environmentManifestCaptureFixture()).replaceAll(
        /https?:\/\/grafana\.example/gu,
        "http://127.0.0.1:3000",
      ),
    ) as ReturnType<typeof environmentManifestCaptureFixture>,
  );

/** Write capture Evidence as `--format json` writes it, then read it as the build command does. */
const captureFile = async (
  root: string,
  evidence: Evidence,
  name = "grafana.capture.json",
) => {
  const path = join(root, name);
  await writeFile(path, evidenceFileBytes(evidence));
  const read = await readEnvironmentExportFile(
    "evidence",
    path,
    "environment-build",
  );
  if (!read.ok) throw read.error;
  return read.value;
};

const buildInput = async (
  root: string,
  evidence: Evidence = analysisViewCaptureEvidence(
    environmentManifestCaptureFixture(),
  ),
  overrides: Partial<EnvironmentBuildInput> = {},
): Promise<EnvironmentBuildInput> => {
  const capture = await captureFile(root, evidence);
  return {
    capture,
    captureInput: "evidence",
    capturePath: capture.path,
    templateRules: DEFAULT_BUILD_TEMPLATE_RULES,
    directory: join(root, "built"),
    dryRun: false,
    ...overrides,
  };
};

/** The three-step path: project the manifest, write both files, export them. */
const threeStep = async (
  root: string,
  evidence: Evidence,
  name: string | undefined,
) => {
  const manifest = inspectAnalysisViewValidated({
    source: { kind: "inline", evidence },
    view: analysisViewRequestSchema.parse({
      kind: "environment-manifest",
      template_rules: [...DEFAULT_BUILD_TEMPLATE_RULES],
    }),
  });
  if (!manifest.ok) throw manifest.error;
  const manifestPath = join(root, "manifest.json");
  const capturePath = join(root, "capture.json");
  await writeFile(manifestPath, evidenceFileBytes(manifest.value));
  await writeFile(capturePath, evidenceFileBytes(evidence));
  const inputs = await readEnvironmentExportInputs(manifestPath, capturePath);
  if (!inputs.ok) throw inputs.error;
  const source = loadEnvironmentSource(
    inputs.value.manifest.value,
    inputs.value.evidence.value,
  );
  if (!source.ok) throw source.error;
  const directory = join(root, "three-step");
  const exported = await exportEnvironmentBundle({
    ...inputs.value,
    source: source.value,
    directory,
    name,
  });
  if (!exported.ok) throw exported.error;
  return { directory, exported: exported.value };
};

const sameTree = async (left: string, right: string): Promise<number> => {
  const files = await listFiles(left);
  expect(await listFiles(right)).toEqual(files);
  for (const file of files)
    expect(await readFile(join(left, file)), file).toEqual(
      await readFile(join(right, file)),
    );
  return files.length;
};

describe("buildEnvironment", () => {
  it("writes the bundle the three-step path writes, byte for byte", async () => {
    const root = await createTestTempDirectory("rea-environment-build-same-");
    const evidence = analysisViewCaptureEvidence(
      environmentManifestCaptureFixture(),
    );
    const input = await buildInput(root, evidence);
    const built = await buildEnvironment(input);
    if (!built.ok) throw built.error;
    const reference = await threeStep(
      await createTestTempDirectory("rea-environment-build-ref-"),
      evidence,
      undefined,
    );
    expect(await sameTree(input.directory!, reference.directory)).toBe(7);
    expect(built.value).toMatchObject({
      status: "built",
      name: "grafana-example",
      capture: {
        evidence_id: evidence.evidence_id,
        operation: "inspect_web_network_capture",
        input: "evidence",
      },
      manifest: {
        evidence_id: reference.exported.manifest_evidence_id,
        template_rules: [...DEFAULT_BUILD_TEMPLATE_RULES],
      },
      state: reference.exported.state,
      tool_count: reference.exported.tool_count,
      package_source: reference.exported.package_source,
      files: reference.exported.files,
      warnings: [],
      next: [`agent-env run ${input.directory!}`],
    });
  });

  it("reports the coverage of the state the bundle serves", async () => {
    const root = await createTestTempDirectory("rea-environment-build-cov-");
    const evidence = analysisViewCaptureEvidence(
      environmentManifestCaptureFixture(),
    );
    const built = await buildEnvironment(
      await buildInput(root, evidence, { dryRun: true, directory: undefined }),
    );
    if (!built.ok) throw built.error;
    const manifest = inspectAnalysisViewValidated({
      source: { kind: "inline", evidence },
      view: analysisViewRequestSchema.parse({
        kind: "environment-manifest",
        template_rules: [...DEFAULT_BUILD_TEMPLATE_RULES],
      }),
    });
    if (!manifest.ok) throw manifest.error;
    const source = loadEnvironmentSource(manifest.value, evidence);
    if (!source.ok) throw source.error;
    const { state } = prepareServedState(source.value, evidence);
    if (state === undefined) throw new Error("Expected a served state");
    expect(built.value.coverage).toEqual(
      summarizeEnvironmentCoverage({
        views: state.views.values(),
        writes: state.writes.values(),
      }),
    );
    expect(
      built.value.coverage!.reads.state + built.value.coverage!.reads.recorded,
    ).toBe(state.views.size);
  });

  it("plans the same files without writing anything on a dry run", async () => {
    const root = await createTestTempDirectory("rea-environment-build-dry-");
    const planned = await buildEnvironment(
      await buildInput(root, undefined, { dryRun: true }),
    );
    if (!planned.ok) throw planned.error;
    await expect(readdir(join(root, "built"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const built = await buildEnvironment(await buildInput(root));
    if (!built.ok) throw built.error;
    const { status, next, ...plannedRest } = planned.value;
    const { status: builtStatus, next: builtNext, ...builtRest } = built.value;
    expect([status, builtStatus]).toEqual(["planned", "built"]);
    expect(next).toEqual([]);
    expect(builtNext).toHaveLength(1);
    expect(plannedRest).toEqual(builtRest);
  });
});

describe("buildEnvironment naming and refusals", () => {
  it("names a loopback capture after its file and says so", async () => {
    const root = await createTestTempDirectory("rea-environment-build-name-");
    const evidence = loopbackCapture();
    const input = await buildInput(root, evidence);
    const built = await buildEnvironment(input);
    if (!built.ok) throw built.error;
    expect(built.value.name).toBe("grafana");
    expect(built.value.warnings).toEqual([
      expect.objectContaining({
        code: "name-from-file",
        message: expect.stringContaining("http://127.0.0.1:3000"),
      }),
    ]);
    const reference = await threeStep(
      await createTestTempDirectory("rea-environment-build-name-ref-"),
      evidence,
      "grafana",
    );
    await sameTree(input.directory!, reference.directory);
    const named = await buildEnvironment({
      ...input,
      name: "my-grafana",
      directory: join(root, "named"),
    });
    if (!named.ok) throw named.error;
    expect(named.value.name).toBe("my-grafana");
    expect(named.value.warnings).toEqual([]);
  });

  it("refuses a loopback capture whose file name yields no name", async () => {
    const root = await createTestTempDirectory("rea-environment-build-noname-");
    const capture = await captureFile(root, loopbackCapture(), "--.json");
    const built = await buildEnvironment({
      capture,
      captureInput: "evidence",
      capturePath: capture.path,
      templateRules: DEFAULT_BUILD_TEMPLATE_RULES,
      directory: join(root, "built"),
      dryRun: false,
    });
    if (built.ok) throw new Error("Expected a refusal");
    expect(projectAnalysisError(built.error)).toMatchObject({
      code: "invalid_request",
      details: {
        operation: "environment-build",
        issues: [{ path: ["name"] }],
      },
    });
    await expect(readdir(join(root, "built"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses evidence that is not a capture, and a build without a directory", async () => {
    const root = await createTestTempDirectory("rea-environment-build-refuse-");
    const evidence = analysisViewCaptureEvidence(
      environmentManifestCaptureFixture(),
    );
    const manifest = inspectAnalysisViewValidated({
      source: { kind: "inline", evidence },
      view: analysisViewRequestSchema.parse({ kind: "environment-manifest" }),
    });
    if (!manifest.ok) throw manifest.error;
    const notCapture = await buildEnvironment(
      await buildInput(root, manifest.value),
    );
    if (notCapture.ok) throw new Error("Expected a refusal");
    expect(projectAnalysisError(notCapture.error)).toMatchObject({
      code: "invalid_request",
      details: { issues: [{ path: ["capture", "operation"] }] },
    });
    const noDirectory = await buildEnvironment(
      await buildInput(root, evidence, { directory: undefined }),
    );
    if (noDirectory.ok) throw new Error("Expected a refusal");
    expect(projectAnalysisError(noDirectory.error)).toMatchObject({
      code: "invalid_request",
      details: { issues: [{ path: ["directory"] }] },
    });
    await expect(readdir(join(root, "built"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses an occupied directory and leaves it as it was", async () => {
    const root = await createTestTempDirectory("rea-environment-build-busy-");
    const input = await buildInput(root);
    await mkdir(input.directory!);
    await writeFile(join(input.directory!, "notes.md"), "keep");
    const built = await buildEnvironment(input);
    if (built.ok) throw new Error("Expected a refusal");
    expect(projectAnalysisError(built.error).code).toBe("invalid_request");
    expect(await listFiles(input.directory!)).toEqual(["notes.md"]);
  });
});

describe("buildEnvironment cancellation and input checks", () => {
  it("writes nothing when cancelled before the bundle stage", async () => {
    const root = await createTestTempDirectory("rea-environment-build-stop-");
    const controller = new AbortController();
    const input = await buildInput(root, undefined, {
      signal: controller.signal,
      progress: (stage) => {
        if (stage === "state") controller.abort();
      },
    });
    const built = await buildEnvironment(input);
    if (built.ok) throw new Error("Expected a cancellation");
    expect(projectAnalysisError(built.error)).toMatchObject({
      code: "cancelled",
      details: { operation: "environment-build" },
    });
    await expect(readdir(input.directory!)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("names the written bundle when cancelled during the write", async () => {
    const root = await createTestTempDirectory("rea-environment-build-late-");
    const controller = new AbortController();
    const input = await buildInput(root, undefined, {
      signal: controller.signal,
      progress: (stage) => {
        if (stage === "bundle") controller.abort();
      },
    });
    const built = await buildEnvironment(input);
    if (built.ok) throw new Error("Expected a cancellation");
    const projected = projectAnalysisError(built.error);
    expect(projected.code).toBe("cancelled");
    expect(JSON.stringify(projected)).toContain(
      `"output_directory":${JSON.stringify(input.directory)}`,
    );
    expect(await listFiles(input.directory!)).toHaveLength(7);
  });

  it("refuses repeated rules and a HAR document saved as JSON", async () => {
    const root = await createTestTempDirectory("rea-environment-build-input-");
    const repeated = await buildEnvironment(
      await buildInput(root, undefined, {
        templateRules: ["opaque-token", "opaque-token"],
      }),
    );
    if (repeated.ok) throw new Error("Expected a refusal");
    expect(projectAnalysisError(repeated.error)).toMatchObject({
      code: "invalid_request",
      details: { issues: [{ path: ["template_rules"] }] },
    });
    const harPath = join(root, "grafana.json");
    await writeFile(harPath, JSON.stringify({ log: { entries: [] } }));
    const har = await readEnvironmentExportFile("evidence", harPath);
    if (!har.ok) throw har.error;
    const asJson = await buildEnvironment({
      capture: har.value,
      captureInput: "evidence",
      capturePath: harPath,
      templateRules: DEFAULT_BUILD_TEMPLATE_RULES,
      dryRun: true,
    });
    if (asJson.ok) throw new Error("Expected a refusal");
    expect(projectAnalysisError(asJson.error)).toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining(".har"),
      details: { issues: [{ path: ["capture"] }] },
    });
  });

  it("refuses an unreadable package tarball on a dry run as a build does", async () => {
    if (process.getuid?.() === 0) return;
    const root = await createTestTempDirectory("rea-environment-build-tgz-");
    const tarball = join(root, "rea-agents.tgz");
    await writeFile(tarball, "packed");
    await chmod(tarball, 0o000);
    try {
      const planned = await buildEnvironment(
        await buildInput(root, undefined, {
          dryRun: true,
          packageTarball: tarball,
        }),
      );
      const built = await buildEnvironment(
        await buildInput(root, undefined, { packageTarball: tarball }),
      );
      if (planned.ok || built.ok) throw new Error("Expected both refusals");
      expect(projectAnalysisError(planned.error).code).toBe("access_denied");
      expect(projectAnalysisError(built.error).code).toBe("access_denied");
    } finally {
      await chmod(tarball, 0o600);
    }
  });

  it("refuses a loopback capture whose file name is too long, and quotes the next command", async () => {
    const root = await createTestTempDirectory("rea-environment-build-long-");
    const long = await captureFile(
      root,
      loopbackCapture(),
      `${"a".repeat(70)}.capture.json`,
    );
    const refused = await buildEnvironment({
      capture: long,
      captureInput: "evidence",
      capturePath: long.path,
      templateRules: DEFAULT_BUILD_TEMPLATE_RULES,
      dryRun: true,
    });
    if (refused.ok) throw new Error("Expected a refusal");
    expect(projectAnalysisError(refused.error)).toMatchObject({
      details: { operation: "environment-build", issues: [{ path: ["name"] }] },
    });
    const built = await buildEnvironment(
      await buildInput(root, undefined, { directory: join(root, "my bundle") }),
    );
    if (!built.ok) throw built.error;
    expect(built.value.next).toEqual([
      `agent-env run '${join(root, "my bundle")}'`,
    ]);
  });
});

describe("classifyBuildCapture", () => {
  it("inspects .har files, reads .json Evidence and refuses anything else", () => {
    expect(classifyBuildCapture("/x/grafana.HAR")).toEqual({
      ok: true,
      value: "har",
    });
    expect(classifyBuildCapture("/x/grafana.capture.json")).toEqual({
      ok: true,
      value: "evidence",
    });
    const refused = classifyBuildCapture("/x/grafana.saz");
    if (refused.ok) throw new Error("Expected a refusal");
    expect(projectAnalysisError(refused.error)).toMatchObject({
      code: "invalid_request",
      details: {
        operation: "environment-build",
        issues: [{ path: ["capture"] }],
      },
    });
  });
});

describe("canonicalTemplateRules", () => {
  it("orders rules as the views apply them", () => {
    expect(
      canonicalTemplateRules(["prefix-variance", "after-uid-literal"]),
    ).toEqual(["after-uid-literal", "prefix-variance"]);
  });
});
