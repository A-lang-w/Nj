import { runProviderAnalysis } from "../../src/application/DirectAnalysis.js";
import type { DirectAnalysisDependencies } from "../../src/application/DirectAnalysisDependencies.js";
import { parseConfig } from "../../src/config/parseConfig.js";
import {
  isImmutableEvidence,
  parseEvidence,
  type Evidence,
} from "../../src/domain/evidence.js";
import { ok } from "../../src/domain/result.js";
import { observed } from "../fixtures/analysisExecution.js";
import {
  createBinarySessionTargets,
  createTestBinarySession,
} from "../fixtures/binarySession.js";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createImmutableEvidenceBundle,
  parseImmutableEvidenceBundle,
} from "../../src/domain/evidenceBundle.js";
import { ArtifactResourceScope } from "../../src/artifacts/ArtifactResourceScope.js";
import {
  deliverAnalysisEvidence,
  inspectAnalysisViewFromBundle,
} from "../../src/application/EvidenceBundleCommands.js";
import { readImmutableEvidenceBundle } from "../../src/application/EvidenceBundleFiles.js";
import { requireAuthenticationHeadroom } from "../../src/application/JsonAuthenticationHeadroom.js";
import { SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE } from "../../src/contracts/javascript/javascriptApplicationWorkflowExamples.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { holdFirstFileRead } from "../support/holdFirstFileRead.js";

vi.mock("../../src/application/JsonAuthenticationHeadroom.js", { spy: true });
vi.mock("../../src/domain/evidenceBundle.js", { spy: true });
afterEach(() => vi.restoreAllMocks());

const savedParent = async () => {
  const root = await createTestTempDirectory("rea-managed-bundle-guard-");
  const path = join(root, "parent.json");
  const parent = SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE.application;
  await writeFile(
    path,
    JSON.stringify(createImmutableEvidenceBundle([parent])),
  );
  return { path, parent };
};

it("admits bundle authentication before cloning and hashing retained records", async () => {
  const { path } = await savedParent();
  const actual = await vi.importActual<
    typeof import("../../src/application/JsonAuthenticationHeadroom.js")
  >("../../src/application/JsonAuthenticationHeadroom.js");
  vi.mocked(requireAuthenticationHeadroom).mockImplementationOnce(
    (value, options) =>
      actual.requireAuthenticationHeadroom(value, {
        ...options,
        availableBytes: 0,
      }),
  );
  vi.mocked(parseImmutableEvidenceBundle).mockClear();
  const resources = new ArtifactResourceScope();
  try {
    expect(
      await readImmutableEvidenceBundle(path, undefined, resources),
    ).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisResourceConstraintError", resource: "memory" },
    });
    expect(parseImmutableEvidenceBundle).not.toHaveBeenCalled();
  } finally {
    await resources.close();
  }
  expect(resources.hasPending).toBe(false);
});

it("preserves the view operation and caller reason when bundle I/O is cancelled", async () => {
  const { path, parent } = await savedParent();
  const held = await holdFirstFileRead(path);
  const controller = new AbortController();
  const reason = new Error("cancel managed bundle page");
  const resources = new ArtifactResourceScope();
  try {
    const pending = inspectAnalysisViewFromBundle(
      {
        source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
        view: { kind: "summary" },
      },
      path,
      resources,
      controller.signal,
    );
    await held.firstRead;
    controller.abort(reason);
    held.release();
    const result = await pending;
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisCancelledError",
        operation: "inspect_analysis_view",
      },
    });
    if (result.ok) throw new Error("Expected cancelled bundle read");
    expect(result.error.cause).toBe(reason);
  } finally {
    held.release();
    await resources.close();
  }
  expect(resources.hasPending).toBe(false);
});

it("retains completed parent facts when bundle publication cannot admit authentication", async () => {
  const root = await createTestTempDirectory("rea-managed-delivery-guard-");
  const evidence = SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE.application;
  const actual = await vi.importActual<
    typeof import("../../src/application/JsonAuthenticationHeadroom.js")
  >("../../src/application/JsonAuthenticationHeadroom.js");
  vi.mocked(requireAuthenticationHeadroom).mockImplementationOnce(
    (value, options) =>
      actual.requireAuthenticationHeadroom(value, {
        ...options,
        availableBytes: 0,
      }),
  );
  vi.mocked(createImmutableEvidenceBundle).mockClear();
  const result = await deliverAnalysisEvidence(
    evidence,
    join(root, "parent.json"),
    "summary",
  );
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError", resource: "memory" },
  });
  if (result.ok) throw new Error("Expected refused bundle authentication");
  expect(result.error.partialObservation).toBe(evidence);
  expect(createImmutableEvidenceBundle).not.toHaveBeenCalled();
  expect(await readdir(root)).toEqual([]);
});

it("projects a rejected managed parent by reference without cloning under low headroom", async () => {
  const root = await createTestTempDirectory(
    "rea-managed-low-heap-projection-",
  );
  const [target] = await createBinarySessionTargets();
  const source = {
    rows: Array.from({ length: 512 }, (_, token) => ({
      token,
      name: "member",
    })),
  };
  let closes = 0;
  const session = () =>
    createTestBinarySession(() => ({
      execute: async () => observed(source),
      close: async () => {
        closes += 1;
        return ok(null);
      },
    }));
  const dependencies: DirectAnalysisDependencies = {
    readConfiguration: () => parseConfig({}),
    createBinarySession: session,
    createNativeDispatchBinarySession: session,
    createArtifactBinarySession: session,
    createNativeBinarySession: session,
    createManagedBinarySession: session,
  };
  const actual = await vi.importActual<
    typeof import("../../src/application/JsonAuthenticationHeadroom.js")
  >("../../src/application/JsonAuthenticationHeadroom.js");
  let parent: Evidence | undefined;
  vi.mocked(requireAuthenticationHeadroom).mockImplementationOnce(
    (value, options) => {
      parent = parseEvidence(value);
      expect(isImmutableEvidence(parent)).toBe(true);
      expect(parent).toBe(value);
      return actual.requireAuthenticationHeadroom(value, {
        ...options,
        availableBytes: 0,
      });
    },
  );
  const result = await runProviderAnalysis(
    dependencies,
    target,
    "inspect_managed_members",
    {},
    undefined,
    undefined,
    {
      detail: "summary",
      evidenceBundlePath: join(root, "parent.json"),
    },
  );
  expect(result).toMatchObject({
    code: "resource_constraint",
    details: { operation: "inspect_managed_members" },
  });
  if (typeof result !== "object" || result === null || Array.isArray(result))
    throw new Error("Expected CLI error");
  const details = result.details;
  if (typeof details !== "object" || details === null || Array.isArray(details))
    throw new Error("Expected CLI error details");
  expect(details.partial_observation).toBe(parent);
  expect(parent?.normalized_result).toEqual(source);
  expect(Object.isFrozen(source.rows[0])).toBe(false);
  expect(closes).toBe(1);
  expect(await readdir(root)).toEqual([]);
});
