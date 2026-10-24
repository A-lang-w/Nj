import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execNpm } from "./npm-command.mjs";

/** Install the selected archive or registry specifier before any protocol deadline. */
export async function installCanaryPackage(specifier, workspace, environment) {
  const prefix = join(workspace, "installed");
  await mkdir(prefix, { recursive: true });
  await writeFile(
    join(prefix, "package.json"),
    JSON.stringify({
      name: "rea-release-consumer-check",
      version: "0.0.0",
      private: true,
    }) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  await execNpm(
    [
      "install",
      "--ignore-scripts",
      "--save-exact",
      "--package-lock=true",
      "--no-audit",
      "--no-fund",
      "--prefix",
      prefix,
      specifier,
    ],
    { cwd: workspace, env: environment, maxBuffer: 16 * 1024 * 1024 },
  );
  return {
    directory: prefix,
    packageRoot: join(prefix, "node_modules", "rea-agents"),
  };
}

export const consumerSecurityOptions = {
  "dependency-security": { type: "string" },
  "dependency-source": { type: "string" },
  "dependency-source-sha": { type: "string" },
};

/** The source that owns a release may differ from the controller's checkout. */
export function consumerSecurityContext(
  values,
  directory = process.cwd(),
  checkoutSha = process.env.GITHUB_SHA,
) {
  const evidenceDirectory = values["dependency-security"];
  const selectedSource = values["dependency-source"],
    selectedSha = values["dependency-source-sha"];
  if (
    (selectedSource === undefined) !== (selectedSha === undefined) ||
    (selectedSource !== undefined && evidenceDirectory === undefined)
  )
    throw new Error(
      "Dependency source overrides require both source directory and SHA with security evidence enabled",
    );
  if (evidenceDirectory === undefined) return null;
  const sourceSha = selectedSha ?? checkoutSha ?? null;
  if (sourceSha !== null && !/^[a-f0-9]{40}$/u.test(sourceSha))
    throw new Error("Dependency source SHA must be a full commit identity");
  return {
    evidenceDirectory,
    referenceLockfile: join(
      resolve(directory, selectedSource ?? "."),
      "package-lock.json",
    ),
    sourceSha,
  };
}

export async function verifyCanaryDependencies(
  installation,
  context,
  version,
  environment,
  qualifiedTarball = null,
) {
  if (context === null) return;
  const { checkDependencySecurity } = await import("./dependency-security.mjs");
  const report = await checkDependencySecurity({
    ...context,
    directory: installation.directory,
    mode: "consumer",
    expectedVersion: version,
    environment,
    qualifiedTarball,
  });
  if (!report.checks_passed)
    throw new Error(
      `Consumer dependency checks failed: ${report.evidence_directory}`,
    );
}
