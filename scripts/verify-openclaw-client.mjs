import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import {
  spawnOwnedProviderProcess,
  ProviderProcessSupervisor,
} from "../dist/process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../dist/process/ProcessOwnership.js";
import {
  createVerifierRun,
  completeVerifierRun,
  assertVerifierCleanupComplete,
} from "./lib/verifier-run.mjs";

// Select an installed published CLI; the verifier never installs a client.
const selected = process.env.REA_VERIFY_OPENCLAW_COMMAND;
assert.ok(
  selected,
  "Set REA_VERIFY_OPENCLAW_COMMAND to OpenClaw's openclaw.mjs.",
);
assert.notEqual(
  process.platform,
  "win32",
  "Native Windows remains unverified by this POSIX lane.",
);
const command = resolve(selected);
const repo = fileURLToPath(new URL("..", import.meta.url));
const rea = join(
  process.env.REA_VERIFY_RUNTIME_ROOT ?? repo,
  "scripts/rea.mjs",
);
const run = createVerifierRun();
const root = await mkdtemp(join(tmpdir(), "rea-openclaw-client-"));
const home = join(root, "account");
await mkdir(home);
const base = {
  PATH: process.env.PATH ?? "",
  HOME: home,
  USERPROFILE: home,
  OPENCLAW_HOME: home,
  REA_PROCESS_RUN_ID: run.run_id,
  REA_LOG_LEVEL: "silent",
  NO_COLOR: "1",
};
const invoke = async (entry, args, env, label) => {
  const launched = await spawnOwnedProviderProcess({
    command: process.execPath,
    arguments: [entry, ...args],
    env,
    cwd: root,
    runId: run.run_id,
    expectedCommand: null,
  });
  const supervisor = new ProviderProcessSupervisor({
    ...launched,
    ownsProcessLifetime: true,
    cleanup: () => cleanupOwnedProcessGroup(launched.ownership),
  });
  try {
    assert.ok(await supervisor.waitForExit(120000), `${label} timed out`);
    assert.ok(
      await supervisor.waitForOutputClose(1000),
      `${label} output did not close`,
    );
    const result = supervisor.snapshot();
    await writeFile(
      join(root, `${label}.log`),
      result.stdout.text + result.stderr.text,
    );
    assert.equal(
      result.exitCode,
      0,
      `${label}: ${result.stdout.text}\n${result.stderr.text}`,
    );
    return result.stdout.text;
  } finally {
    const cleanup = await supervisor.stop();
    assert.equal(cleanup.status, "verified-cleanup", JSON.stringify(cleanup));
  }
};
let clean = false;
let nativeToolCount;
try {
  const version = (
    await invoke(command, ["--version"], base, "version")
  ).trim();
  assert.match(
    version,
    /2026\.10\.5/u,
    "This acceptance record pins OpenClaw 2026.10.5.",
  );
  const cases = [
    {
      name: "home",
      env: {},
      config: join(home, ".openclaw", "openclaw.json"),
      skills: join(home, ".openclaw", "skills"),
    },
    {
      name: "config-only",
      env: { OPENCLAW_CONFIG_PATH: join(root, "profile", "work.json5") },
      config: join(root, "profile", "work.json5"),
      skills: join(root, "profile", "skills"),
    },
    {
      name: "combined",
      env: {
        OPENCLAW_HOME: join(root, "other home"),
        OPENCLAW_STATE_DIR: "~/state",
        OPENCLAW_CONFIG_PATH: "~/config/work.json5",
      },
      config: join(root, "other home", "config", "work.json5"),
      skills: join(root, "other home", "state", "skills"),
    },
  ];
  for (const item of cases) {
    const env = { ...base, ...item.env };
    await mkdir(dirname(item.config), { recursive: true });
    const original = `{\n// Keep JSON5 source spelling.\ngateway: {mode: 'local'},\nmcp: {servers: {other: {command: 'unrelated-server', enabled: false}}},\n}\n`;
    await writeFile(item.config, original);
    const prefix = item.name;
    const nativePath = JSON.parse(
      await invoke(
        command,
        ["config", "file", "--json"],
        env,
        `${prefix}-native-path`,
      ),
    );
    assert.equal(nativePath.path, item.config);
    const plan = JSON.parse(
      await invoke(
        rea,
        ["setup", "--client", "openclaw", "--dry-run", "--json"],
        env,
        `${prefix}-plan`,
      ),
    );
    assert.ok(plan.plannedActions.some(({ target }) => target === item.config));
    await invoke(
      rea,
      ["setup", "--client", "openclaw", "--yes", "--json"],
      env,
      `${prefix}-setup`,
    );
    const configured = await readFile(item.config, "utf8");
    assert.ok(configured.includes("// Keep JSON5 source spelling."));
    assert.ok(
      configured.includes(
        "other: {command: 'unrelated-server', enabled: false}",
      ),
    );
    assert.equal(await readFile(`${item.config}.rea.backup`, "utf8"), original);
    const entry = JSON5.parse(configured).mcp.servers.rea;
    assert.equal(entry.transport, "stdio");
    assert.equal(entry.enabled, true);
    assert.ok(
      entry.command === rea || entry.args?.includes(rea),
      "Native probe must launch this selected REA runtime",
    );
    assert.ok(
      (
        await readFile(
          join(item.skills, "reverse-engineer-anything", "SKILL.md"),
          "utf8",
        )
      ).includes("name: reverse-engineer-anything"),
    );
    await invoke(
      command,
      ["config", "validate", "--json"],
      env,
      `${prefix}-validate`,
    );
    const shown = await invoke(
      command,
      ["mcp", "show", "rea", "--json"],
      env,
      `${prefix}-show`,
    );
    assert.ok(shown.includes(entry.command));
    if (item.name === "combined") {
      const probe = await invoke(
        command,
        ["mcp", "probe", "rea", "--json"],
        env,
        `${prefix}-probe`,
      );
      nativeToolCount = JSON.parse(probe).servers.rea.tools;
      assert.ok(
        nativeToolCount > 0,
        "Native MCP probe must discover REA tools",
      );
      await invoke(
        rea,
        ["doctor", "--client", "openclaw", "--skill", "--json"],
        env,
        `${prefix}-doctor`,
      );
    }
    await invoke(
      rea,
      ["setup", "--client", "openclaw", "--yes", "--json"],
      env,
      `${prefix}-idempotent`,
    );
    assert.equal(await readFile(item.config, "utf8"), configured);
    await invoke(rea, ["uninstall", "--json"], env, `${prefix}-uninstall`);
    const after = await readFile(item.config, "utf8");
    assert.equal(JSON5.parse(after).mcp.servers.rea, undefined);
    assert.ok(
      after.includes("other: {command: 'unrelated-server', enabled: false}"),
    );
    await invoke(
      command,
      ["config", "validate", "--json"],
      env,
      `${prefix}-validate-after-uninstall`,
    );
  }
  const receipt = await completeVerifierRun(run);
  assertVerifierCleanupComplete(receipt.process_lineage);
  clean = true;
  console.log(
    JSON.stringify({
      status: "passed",
      client: version,
      host: `${process.platform}/${process.arch}`,
      native_tool_count: nativeToolCount,
      checks: [
        "native_config_paths",
        "public_setup_preview",
        "native_json5_validation",
        "native_registry_readback",
        "native_stdio_probe",
        "personal_skill_destination",
        "idempotence",
        "backup_and_uninstall_preservation",
      ],
      verifier_run: receipt,
      limits:
        "No model or gateway turn, no Windows-host or older-client acceptance claim.",
    }),
  );
} finally {
  if (clean) await rm(root, { recursive: true, force: true });
  else
    console.error(
      `Verification incomplete; owned diagnostics retained at ${root}`,
    );
}
