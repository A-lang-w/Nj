import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeWorkflowRun } from "./workflow-run.mjs";

const LEGACY_ARTIFACT = "test-timings";
const LEGACY_EVENTS = ["schedule", "workflow_dispatch"];
const TIER_EVENTS = ["push", "schedule", "workflow_dispatch"];
const TIER_PROFILES = {
  fast: { artifactName: "test-timings-fast", events: TIER_EVENTS },
  full: { artifactName: "test-timings-full", events: TIER_EVENTS },
};
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CANDIDATES = 5;
const EMPTY_SELECTION = { runId: "", artifactName: "" };
const positiveId = (value) =>
  (typeof value === "string" || typeof value === "number") &&
  /^[1-9]\d*$/.test(String(value)) &&
  Number.isSafeInteger(Number(value));

function findTimingRun({
  repository,
  branch,
  repositoryId,
  tier,
  now = Date.now(),
}) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") ||
    !branch ||
    !positiveId(repositoryId)
  )
    return EMPTY_SELECTION;
  const deadline = Date.now() + 20_000;
  const api = (...arguments_) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new Error("Timing history lookup budget exhausted");
    return JSON.parse(
      execFileSync("gh", ["api", "--method", "GET", ...arguments_], {
        encoding: "utf8",
        timeout: Math.min(10_000, remaining),
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  };
  const search = ({ artifactName, events }) => {
    const { artifacts } = api(
      `repos/${repository}/actions/artifacts`,
      "-f",
      `name=${artifactName}`,
      "-F",
      "per_page=100",
    );
    if (!Array.isArray(artifacts))
      throw new Error("Missing timing artifact inventory");
    const candidates = artifacts
      .filter((artifact) => {
        const lineage = artifact?.workflow_run;
        const age = now - Date.parse(artifact?.created_at);
        return (
          artifact?.name === artifactName &&
          artifact?.expired === false &&
          typeof artifact?.created_at === "string" &&
          Number.isFinite(age) &&
          age >= 0 &&
          age < MAX_AGE_MS &&
          positiveId(lineage?.id) &&
          positiveId(lineage?.repository_id) &&
          positiveId(lineage?.head_repository_id) &&
          lineage.repository_id === lineage.head_repository_id &&
          lineage.repository_id === Number(repositoryId) &&
          lineage.head_branch === branch
        );
      })
      .sort(
        (left, right) =>
          Date.parse(right.created_at) - Date.parse(left.created_at),
      )
      .slice(0, MAX_CANDIDATES);

    let sawTrustedCandidates = false;
    for (const artifact of candidates) {
      const run = normalizeWorkflowRun(
        api(`repos/${repository}/actions/runs/${artifact.workflow_run.id}`),
      );
      const runAge = now - Date.parse(run?.created_at);
      const trustedEvent = events.includes(run.event);
      if (trustedEvent) sawTrustedCandidates = true;
      if (
        typeof run?.created_at === "string" &&
        Number.isFinite(runAge) &&
        runAge >= 0 &&
        runAge < MAX_AGE_MS &&
        run.id === artifact.workflow_run.id &&
        run.status === "completed" &&
        run.conclusion === "success" &&
        run.workflowPath?.file === ".github/workflows/ci.yml" &&
        trustedEvent &&
        run.head_branch === branch &&
        run.head_repository?.full_name === repository
      )
        return { runId: String(run.id), sawTrustedCandidates: true };
    }
    return { runId: "", sawTrustedCandidates };
  };

  // Fast shards run without coverage. Packing them with the latest full-suite
  // weights leaves a shard idle after those files speed up and piles the
  // remaining long files onto the others. Each tier keeps its own artifact.
  // A trusted candidate that does not qualify must not fall back to the other
  // tier: an empty result uses Vitest's own assignment. Untrusted producers,
  // including pull requests, still fall back to legacy history.
  const profile = Object.hasOwn(TIER_PROFILES, tier)
    ? TIER_PROFILES[tier]
    : null;
  if (profile) {
    const primary = search(profile);
    if (primary.runId)
      return { runId: primary.runId, artifactName: profile.artifactName };
    if (primary.sawTrustedCandidates) return EMPTY_SELECTION;
  }
  const legacy = search({
    artifactName: LEGACY_ARTIFACT,
    events: LEGACY_EVENTS,
  });
  return legacy.runId
    ? { runId: legacy.runId, artifactName: LEGACY_ARTIFACT }
    : EMPTY_SELECTION;
}

function write({ runId, artifactName }) {
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `run-id=${runId}\nartifact-name=${artifactName}\n`,
    );
  console.log(JSON.stringify({ run_id: runId, artifact_name: artifactName }));
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  let selection = EMPTY_SELECTION;
  try {
    selection = findTimingRun({
      repository: process.env.CI_REPOSITORY,
      branch: process.env.CI_DEFAULT_BRANCH,
      repositoryId: process.env.CI_REPOSITORY_ID,
      tier: process.env.CI_TIMING_TIER,
    });
  } catch {
    // History improves shard ordering but must never block CI.
  }
  write(selection);
}
