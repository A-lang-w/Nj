import { expect, it } from "vitest";
import {
  dependencyReconstructionCoverageData,
  contradictionReconstructionCoverageData,
} from "../../../src/domain/reconstructionCoverage.fixture.js";
import { runCliJson } from "../../fixtures/cliJsonProcess.js";

it("reports a transitive missing dependency through the compiled CLI and preserves complete controls", async () => {
  const observedAt = new Date().toISOString();
  for (const [edges, status] of [
    [{ "cli.help": [] }, "ready"],
    [{ "cli.help": ["absent"] }, "partial"],
    [{ "cli.help": ["dep"], dep: ["absent"] }, "partial"],
    [{ "cli.help": ["dep"], dep: ["absent"], absent: [] }, "ready"],
  ] as const) {
    const input = {
      coverage: dependencyReconstructionCoverageData(edges, observedAt),
      boundary_id: "replacement.cli",
    };
    const result = await runCliJson([
      "evaluate-reconstruction-coverage",
      JSON.stringify(input),
      "--json",
    ]);
    expect(result).toMatchObject({ status, boundary_id: "replacement.cli" });
  }
});

it("fails on declared dependency contradictions even before registration and preserves remaining inventory gaps", async () => {
  for (const registered of [false, true]) {
    const edges: Readonly<Record<string, readonly string[]>> = registered
      ? { "cli.help": ["mid"], mid: ["dep"], dep: [] }
      : { "cli.help": ["mid"], mid: ["dep"] };
    const coverage = dependencyReconstructionCoverageData(
      edges,
      new Date().toISOString(),
    );
    for (const contradictionStatus of ["active", "resolved"] as const) {
      const input = {
        coverage: contradictionReconstructionCoverageData(
          coverage,
          ["dep"],
          contradictionStatus,
        ),
        boundary_id: "replacement.cli",
      };
      const result = await runCliJson([
        "evaluate-reconstruction-coverage",
        JSON.stringify(input),
        "--json",
      ]);
      expect(result).toMatchObject({
        status:
          contradictionStatus === "active"
            ? "failed"
            : registered
              ? "ready"
              : "partial",
        summary: { required_surfaces: 1 },
        reasons: [
          ...(contradictionStatus === "active"
            ? [
                {
                  code: "active-contradiction",
                  subject_id: "contradiction.fixture",
                },
              ]
            : []),
          ...(!registered
            ? [{ code: "dependency-surface-missing", subject_id: "mid" }]
            : []),
        ],
      });
    }
  }
});
