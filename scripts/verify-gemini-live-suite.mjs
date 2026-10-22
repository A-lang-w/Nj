import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const lane = join(repo, "scripts", "verify-gemini-live.mjs");
const modes = ["call", "chat"];
// A host or credential problem fails every mode identically, so a second run
// would spend model budget restating the same blocker.
const blockingKinds = new Set([
  "missing_api_key",
  "network_unreachable",
  "credential_rejected",
  "client_preflight_failed",
]);

/** Run one lane mode in its own process and keep both streams. */
const runMode = (mode) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [lane, mode], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

const parseReceipt = (stdout) => {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
};

/** A lane that fails before its receipt exists still prints its classification. */
const laneFailure = (stderr) => {
  const line = stderr
    .split("\n")
    .find((text) => text.startsWith("[rea-gemini-live:"));
  if (line === undefined) return undefined;
  return {
    kind: /\[rea-gemini-live:([a-z_]+)\]/u.exec(line)?.[1] ?? "unclassified",
    message: line,
  };
};

const receiptDir =
  process.env.REA_VERIFY_GEMINI_RECEIPT_DIR ??
  (await mkdtemp(join(tmpdir(), "rea-gemini-live-suite-")));
await mkdir(receiptDir, { recursive: true });
const results = [];
for (const mode of modes) {
  const { code, stdout, stderr } = await runMode(mode);
  const receipt = parseReceipt(stdout);
  await writeFile(
    join(receiptDir, `${mode}.receipt.json`),
    receipt === undefined ? stdout : JSON.stringify(receipt, null, 2),
  );
  await writeFile(join(receiptDir, `${mode}.stderr`), stderr);
  const failure = receipt?.failure ?? laneFailure(stderr);
  const kind = failure?.kind;
  results.push({
    mode,
    exitCode: code,
    passed: code === 0,
    failureKind: kind,
    artifacts: receipt?.artifacts,
    model: receipt?.model,
    clientVersion: receipt?.clientVersion,
    endpoint: receipt?.endpoint,
    run: receipt?.run,
    evidence: receipt?.evidence,
    failure,
    stderr: stderr.trim().slice(-800),
  });
  if (code !== 0 && (kind === undefined || blockingKinds.has(kind))) break;
}
const suite = {
  suite: "verify:gemini-live",
  passed: results.every((result) => result.passed),
  modesRun: results.map((result) => result.mode),
  modes: results,
  receiptDir,
  host: {
    platform: process.platform,
    architecture: process.arch,
    node: process.versions.node,
  },
  coverage:
    "Live model service accepted the credential in each completed mode; no fixture model and no synthetic token counts",
};
await writeFile(join(receiptDir, "suite.json"), JSON.stringify(suite, null, 2));
console.log(JSON.stringify(suite, null, 2));
if (!suite.passed) process.exitCode = 1;
