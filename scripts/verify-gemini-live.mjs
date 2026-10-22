import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toolContract } from "../dist/contracts/toolContracts.js";
import { assertJavaScriptApplicationInputPaths } from "./lib/javascript-application-paths.mjs";
import {
  DEFAULT_GEMINI_BASE_URL,
  LiveLaneError,
  classifyProbeFailure,
  parseClientEvents,
  probeGeminiEndpoint,
  readLiveCredential,
  redact,
  requireToolEvidence,
  summarizeClientEvents,
} from "./lib/live-gemini-lane.mjs";
import { exec } from "./lib/verify-package-core.mjs";
import { completeVerifierRun, createVerifierRun } from "./lib/verifier-run.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const runtimeRoot = process.env.REA_VERIFY_RUNTIME_ROOT ?? repo;
const command = process.env.REA_VERIFY_GEMINI_COMMAND ?? "gemini";
// npm installs of Gemini CLI provide a JavaScript entry point; on Windows only a
// gemini.cmd shim reaches PATH, which Node does not spawn without a shell.
const entryPoint = /\.(c|m)?js$/iu.test(command) ? resolve(command) : undefined;
const launch = (args) =>
  entryPoint === undefined
    ? [command, args]
    : [process.execPath, [entryPoint, ...args]];
const mode = process.argv[2] ?? "call";
assert(
  ["chat", "call"].includes(mode),
  "Usage: verify-gemini-live.mjs [chat|call]",
);
const model = process.env.REA_VERIFY_GEMINI_MODEL ?? "gemini-2.5-flash";
const baseUrl =
  process.env.REA_VERIFY_GEMINI_BASE_URL ?? DEFAULT_GEMINI_BASE_URL;
const schemaProfile = process.env.REA_MCP_INPUT_SCHEMA_PROFILE ?? "compact";
const requireSkill = process.env.REA_VERIFY_GEMINI_REQUIRE_SKILL !== "0";
const timeoutMs = Number(process.env.REA_VERIFY_GEMINI_TIMEOUT_MS ?? 900_000);
const MARKER = "REA_CLIENT_LIVE_OK";
const SKILL_NAME = "reverse-engineer-anything";
const EXPECTED_LITERALS = {
  "/clientCompatibility": "REA_LIVE_FIXTURE",
  "/count": 7,
};

/** Configure the isolated profile through the public CLI, then require a healthy doctor. */
const configureClient = async ({ environment, workspace, lab, profile }) => {
  const steps = [
    { name: "setup-plan", args: ["--dry-run"], expected: "planned" },
    { name: "setup", args: ["--yes"], expected: "ready" },
    { name: "doctor", args: [], expected: undefined },
  ];
  const summary = {};
  for (const step of steps) {
    const doctor = step.name === "doctor";
    const result = await exec(
      process.execPath,
      [
        join(runtimeRoot, "scripts/rea.mjs"),
        doctor ? "doctor" : "setup",
        "--client",
        "gemini_cli",
        ...(doctor ? ["--skill"] : step.args),
        "--json",
      ],
      { env: environment, cwd: workspace, timeout: 60_000 },
    );
    const parsed = JSON.parse(result.stdout);
    await writeFile(join(lab, `${step.name}.json`), result.stdout);
    if (step.expected === undefined)
      assert.equal(
        parsed.healthy,
        true,
        "rea doctor reported an unhealthy registration",
      );
    else
      assert.equal(
        parsed.status,
        step.expected,
        `rea setup ${step.args[0]} did not report ${step.expected}`,
      );
    summary[step.name] = step.expected ?? "healthy";
  }
  const skill = await readFile(
    join(profile, ".agents", "skills", SKILL_NAME, "SKILL.md"),
    "utf8",
  );
  assert(
    skill.includes(`name: ${SKILL_NAME}`),
    "rea setup did not install the personal REA skill into the selected profile",
  );
  return summary;
};

/** Run the real client against the live model service and keep redacted transcripts. */
const runClient = async ({ lab, target, workspace, environment, key }) => {
  const prompt =
    mode === "chat"
      ? `Reply with exactly ${MARKER} and nothing else.`
      : `Activate the REA skill named ${SKILL_NAME}, then use REA to analyze the JavaScript directory ${target}. Report the literal return shape of the exported result function. End your reply with a line containing exactly ${MARKER}.`;
  const started = Date.now();
  let stdout = "";
  let stderr = "";
  let failure;
  try {
    const response = await exec(
      ...launch([
        "--model",
        model,
        "--approval-mode",
        mode === "chat" ? "default" : "yolo",
        "--allowed-mcp-server-names",
        "rea",
        "--output-format",
        "stream-json",
        "-p",
        prompt,
      ]),
      {
        env: {
          ...environment,
          GEMINI_API_KEY: key,
          GOOGLE_GEMINI_BASE_URL: baseUrl,
        },
        cwd: workspace,
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    stdout = response.stdout;
    stderr = response.stderr;
  } catch (cause) {
    stdout = typeof cause?.stdout === "string" ? cause.stdout : "";
    stderr = typeof cause?.stderr === "string" ? cause.stderr : String(cause);
    failure = new LiveLaneError(
      "client_run_failed",
      `Gemini CLI exited unsuccessfully: ${cause?.message ?? "unknown failure"}`,
      stderr.slice(-4_000),
    );
  }
  await writeFile(join(lab, `${mode}.stdout`), redact(stdout, key));
  await writeFile(join(lab, `${mode}.stderr`), redact(stderr, key));
  if (failure !== undefined) throw failure;
  return { stdout, elapsedMs: Date.now() - started };
};

/** Require the live model to return REA Evidence that still carries the fixture literals. */
const checkAnalysisEvidence = async (summary, target) => {
  const { call, decoded } = requireToolEvidence(
    summary,
    "analyze_javascript_application",
  );
  assert(
    decoded !== undefined,
    `${call.name}: tool result is not JSON Evidence`,
  );
  const evidence = toolContract(
    "analyze_javascript_application",
  ).outputSchema.parse(decoded);
  await assertJavaScriptApplicationInputPaths(evidence, target);
  const shape = evidence.normalized_result.graph.nodes
    .flatMap((node) => node.observations)
    .map((observation) => observation.properties)
    .find(
      (properties) =>
        properties.semantic_role === "export-return-shapes" &&
        properties.exported_name === "result",
    );
  assert(shape?.return_shape_coverage?.projection_complete);
  const observed = new Map(
    shape.static_return_shapes
      .flatMap((variant) => variant.fields)
      .filter((field) => field.state === "literal")
      .map((field) => [field.path, field.value]),
  );
  for (const [path, value] of Object.entries(EXPECTED_LITERALS))
    assert.equal(
      observed.get(path),
      value,
      `Live Evidence lost the ${path} literal from ${target}`,
    );
  return {
    evidence_id: evidence.evidence_id,
    tool: call.name,
    artifactDigest: createHash("sha256")
      .update(JSON.stringify(evidence))
      .digest("hex"),
  };
};

/** Build the disposable account, profile, Git workspace and analysis fixture. */
const prepareLab = async ({ verifier }) => {
  const lab = await mkdtemp(join(tmpdir(), "rea-gemini-live-"));
  const account = join(lab, "account");
  const profile = join(lab, "selected profile");
  const workspace = join(lab, "workspace");
  await Promise.all([
    mkdir(account),
    mkdir(workspace),
    mkdir(join(profile, ".gemini"), { recursive: true }),
  ]);
  await exec("git", ["init", "--quiet", workspace], { timeout: 30_000 });
  await writeFile(
    join(profile, ".gemini", "settings.json"),
    `${JSON.stringify(
      {
        security: { auth: { selectedType: "gemini-api-key" } },
        telemetry: { enabled: false },
        advanced: { autoConfigureMemory: false },
        model: { name: model, maxSessionTurns: 12 },
      },
      null,
      2,
    )}\n`,
  );
  const target = join(lab, "fixture α测试");
  await mkdir(target);
  await writeFile(
    join(target, "app.js"),
    'export function result() { return { clientCompatibility: "REA_LIVE_FIXTURE", count: 7 }; }\n',
  );
  return {
    lab,
    profile,
    workspace,
    target,
    environment: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME,
      USERPROFILE: account,
      GEMINI_CLI_HOME: profile,
      GEMINI_CLI_NO_RELAUNCH: "1",
      GEMINI_CLI_TRUST_WORKSPACE: "true",
      REA_PROCESS_RUN_ID: verifier.run_id,
      REA_MCP_INPUT_SCHEMA_PROFILE: schemaProfile,
    },
  };
};

/** Require a successful live session that reached REA tools and the fixture Evidence. */
const checkClientRun = async ({ summary, target, elapsedMs }) => {
  assert.equal(
    summary.result?.status,
    "success",
    "The live client did not report a successful result event",
  );
  assert(
    summary.toolCalls.some((call) => call.name.startsWith("mcp_rea_")),
    `The live model called no REA tool: ${summary.toolCalls.map((call) => call.name).join(", ") || "none"}`,
  );
  const skillActivated = summary.toolCalls.some((call) => {
    if (call.name !== "activate_skill") return false;
    const result = summary.results.get(call.id);
    const output = String(result?.output ?? "");
    // Gemini CLI renders its native skill result; other hosts forward the raw
    // MCP envelope, so both forms establish activation.
    return (
      result?.status === "success" &&
      (output.includes(`<activated_skill name="${SKILL_NAME}">`) ||
        output.includes(`Skill **${SKILL_NAME}** activated`))
    );
  });
  if (mode === "call" && requireSkill)
    assert(
      skillActivated,
      "The live model did not activate the installed personal REA skill; set REA_VERIFY_GEMINI_REQUIRE_SKILL=0 to record this without failing",
    );
  const evidence =
    mode === "call" ? await checkAnalysisEvidence(summary, target) : undefined;
  assert(
    summary.assistantText.includes(MARKER),
    "The live model's final reply omitted the required completion marker",
  );
  return {
    evidence,
    run: {
      elapsedMs,
      skillActivated,
      reaToolCalls: summary.toolCalls
        .filter((call) => call.name.startsWith("mcp_rea_"))
        .map((call) => call.name),
      allToolCalls: summary.toolCalls.map((call) => call.name),
      stats: summary.result.stats,
      sessionId: summary.sessionId,
    },
  };
};

/** Build the caller-facing receipt; the credential source is recorded, never its value. */
const buildReceipt = async ({
  failure,
  report,
  probe,
  credential,
  clientVersion,
  lab,
  verifier,
}) => ({
  client: "Gemini CLI",
  clientVersion,
  mode,
  model,
  endpoint: {
    baseUrl: probe.baseUrl,
    status: probe.status,
    reachable: probe.reachable,
  },
  credentialSource: credential.source,
  schemaProfile,
  passed: failure === undefined,
  ...report,
  artifacts: lab,
  runtimeRoot,
  host: {
    platform: process.platform,
    architecture: process.arch,
    node: process.versions.node,
  },
  coverage:
    "A live model service accepted the credential and completed an REA MCP session; no fixture model and no synthetic token counts",
  failure:
    failure === undefined
      ? undefined
      : {
          kind: failure?.kind ?? "assertion",
          message: redact(String(failure?.message ?? failure), credential.key),
          detail: redact(String(failure?.detail ?? ""), credential.key),
        },
  verifier: await completeVerifierRun(verifier),
});

/** Report a classified lane failure without a stack trace; assertions still throw. */
const reportLaneFailure = (cause) => {
  if (!(cause instanceof LiveLaneError)) throw cause;
  process.stderr.write(
    `[rea-gemini-live:${cause.kind}] ${cause.message}\n${cause.detail ?? ""}\n`,
  );
  process.exitCode = 2;
};

const main = async () => {
  const credential = readLiveCredential();
  const verifier = createVerifierRun();
  const probe = await probeGeminiEndpoint({
    baseUrl,
    key: credential.key,
    timeoutMs: 60_000,
  });
  const probeKind = classifyProbeFailure(probe);
  if (probeKind !== undefined)
    throw new LiveLaneError(
      probeKind,
      probeKind === "network_unreachable"
        ? `Cannot reach ${probe.baseUrl}; generativelanguage.googleapis.com must be reachable from this host.`
        : `The Gemini API rejected the ${credential.source} credential with HTTP ${probe.status}.`,
      probe.detail,
    );
  const { lab, profile, workspace, target, environment } = await prepareLab({
    verifier,
  });
  let clientVersion;
  try {
    clientVersion = (
      await exec(...launch(["--version"]), {
        env: environment,
        timeout: 30_000,
      })
    ).stdout.trim();
  } catch (cause) {
    throw new LiveLaneError(
      "client_preflight_failed",
      `Gemini preflight failed for ${command}; install Gemini CLI or set REA_VERIFY_GEMINI_COMMAND.`,
      String(cause),
    );
  }
  let failure;
  const report = { setup: undefined, run: undefined, evidence: undefined };
  try {
    report.setup = await configureClient({
      environment,
      workspace,
      lab,
      profile,
    });
    const { stdout, elapsedMs } = await runClient({
      lab,
      target,
      workspace,
      environment,
      key: credential.key,
    });
    const summary = summarizeClientEvents(parseClientEvents(stdout));
    const checked = await checkClientRun({ summary, target, elapsedMs });
    report.evidence = checked.evidence;
    report.run = checked.run;
  } catch (cause) {
    failure = cause;
  } finally {
    const receipt = await buildReceipt({
      failure,
      report,
      probe,
      credential,
      clientVersion,
      lab,
      verifier,
    });
    await writeFile(
      join(lab, "receipt.json"),
      JSON.stringify(receipt, null, 2),
    );
    console.log(JSON.stringify(receipt, null, 2));
  }
  if (failure !== undefined) throw failure;
};

try {
  await main();
} catch (cause) {
  reportLaneFailure(cause);
}
