import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parseEvidence } from "../../../dist/domain/evidence.js";
import { hashAndroidFile } from "./digest.mjs";
import fixture from "../../fixtures/android/apidemos.json" with { type: "json" };

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const apk = process.env.REA_ANDROID_TEST_APK;
assert(
  apk && process.env.REA_ASC_PYTHON,
  "Select REA_ANDROID_TEST_APK (pinned ApiDemos) and REA_ASC_PYTHON with an existing DroidASC installation",
);
assert.equal(await hashAndroidFile(apk), fixture.sha256);
// Prove ASC selection does not acquire Java/JADX as a fallback or prerequisite.
const environment = {
  ...process.env,
  JAVA_HOME: resolve(root, "_reference/absent-java-for-asc-verification"),
};
delete environment.REA_JADX_MCP_JAR;
const execute = promisify(execFile);
const cli = (args) =>
  execute(
    process.execPath,
    [resolve(root, "scripts/rea.mjs"), ...args, "--format", "json"],
    {
      cwd: root,
      env: environment,
      timeout: 150_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
const selected = await cli([
  "search-android-classes",
  apk,
  "ApiDemos",
  "--backend",
  "asc",
]);
const evidence = parseEvidence(JSON.parse(selected.stdout));
assert.equal(evidence.provider.id, "asc");
assert.equal(evidence.subject.digest.sha256, fixture.sha256);
assert.equal(evidence.normalized_result.inventory_kind, "dex_definitions");
assert(evidence.normalized_result.matches.includes(fixture.class_name));
assert(
  evidence.raw_result.dexes.every((dex) => /^[a-f0-9]{64}$/.test(dex.sha256)),
);
console.log(
  "PASS actual ASC CLI Evidence, raw DEX identity and no Java/JADX dependency",
);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(root, "scripts/rea.mjs"), "mcp"],
  cwd: root,
  env: environment,
  stderr: "pipe",
});
transport.stderr?.on("data", () => {});
const client = new Client({ name: "rea-real-asc-verifier", version: "1" });
try {
  await client.connect(transport, { timeout: 30_000 });
  const discovered = await client.listTools();
  const contract = discovered.tools.find(
    (tool) => tool.name === "search_android_classes",
  );
  assert(contract && JSON.stringify(contract.inputSchema).includes("backend"));
  const response = await client.callTool(
    {
      name: "search_android_classes",
      arguments: { path: apk, query: "ApiDemos", backend: "asc" },
    },
    { timeout: 150_000 },
  );
  assert.notEqual(response.isError, true, JSON.stringify(response));
  const mcp = parseEvidence(response.structuredContent);
  assert.deepEqual(mcp.normalized_result, evidence.normalized_result);
  assert.equal(mcp.subject.digest.sha256, fixture.sha256);
  assert.equal(mcp.parameters.backend, "asc");
  console.log(
    "PASS actual ASC MCP discovery, selection, CLI parity and artifact-bound Evidence",
  );
  const absent = await client.callTool(
    {
      name: "search_android_classes",
      arguments: {
        path: apk,
        query: "REA_ASC_ABSENT_CLASS_2fca9",
        backend: "asc",
      },
    },
    { timeout: 150_000 },
  );
  assert.notEqual(absent.isError, true);
  assert.deepEqual(
    parseEvidence(absent.structuredContent).normalized_result.matches,
    [],
  );
  const unsupported = await client.callTool(
    {
      name: "inspect_android_class",
      arguments: { path: apk, class_name: fixture.class_name, backend: "asc" },
    },
    { timeout: 150_000 },
  );
  assert.equal(unsupported.isError, true);
  assert(
    JSON.stringify(unsupported).includes(
      "DroidASC currently supports only search_android_classes",
    ),
  );
  console.log(
    "PASS real no-match and unsupported-operation outcomes without fallback",
  );
} finally {
  await client.close();
}
assert.equal(await hashAndroidFile(apk), fixture.sha256);
console.log(
  "PASS original APK unchanged; static analysis never executes the APK",
);
