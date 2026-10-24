import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import { elf } from "../domain/binaryTarget.fixture.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { functionDossierSchema } from "../domain/hopperValues.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import type { OwnedProviderProcessSpawnOptions } from "../process/ProviderProcess.js";
import type { BinaryNinjaHeadlessLauncher } from "./BinaryNinjaHeadlessBridgeProcess.js";
import type { AvailableBinaryNinjaHeadlessInstallation } from "./BinaryNinjaHeadlessInstallation.js";
import {
  BINARY_NINJA_BRIDGE_ENVIRONMENT,
  BinaryNinjaHeadlessSessionClient,
} from "./BinaryNinjaHeadlessSessionClient.js";

const fixturePath = fileURLToPath(
  new URL("../../tests/fixtures/fakeBinaryNinjaBridge.mjs", import.meta.url),
);
const bridgeScriptPath = "/rea/bridge/binaryninja/rea_binaryninja_bridge.py";

const installation: AvailableBinaryNinjaHeadlessInstallation = {
  status: "available",
  installDir: "/opt/binaryninja",
  installDirSource: "setting",
  apiDir: "/opt/binaryninja/python",
  pythonPath: "/usr/bin/python3",
  pythonSource: "setting",
};

const children = new Set<ChildProcess>();
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
  children.clear();
});

/** Run the Node fixture in place of the Python interpreter; REA still owns its exit. */
const fixtureLauncher = (
  mode: string,
  observe?: (options: OwnedProviderProcessSpawnOptions) => void,
): BinaryNinjaHeadlessLauncher => {
  return async (options) => {
    observe?.(options);
    const child = spawn(
      process.execPath,
      [fixturePath, mode, ...options.arguments],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...options.hostEnvironment,
          ...options.env,
          REA_PROCESS_RUN_ID: options.runId,
        },
      },
    );
    children.add(child);
    await once(child, "spawn");
    const pid = child.pid ?? 0;
    const exited = once(child, "exit").then(() => undefined);
    return {
      process: child,
      ownership: {
        runId: options.runId,
        leaderPid: pid,
        processGroupId: pid,
        expectedParentPid: process.pid,
      },
      cleanup: async () => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        await exited;
        return { cleaned: true, signaled: true };
      },
    };
  };
};

const createTarget = async (): Promise<BinaryTarget> => {
  const root = await createTestTempDirectory("rea-binary-ninja-");
  const path = join(root, "target.elf");
  const bytes = elf(2, 1, 0x3e);
  await writeFile(path, bytes);
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    kind: "executable",
    format: "elf",
    architecture: "x86_64",
    availableArchitectures: ["x86_64"],
  };
};

const createClient = (
  target: BinaryTarget,
  mode = "normal",
  options: {
    readonly startupTimeoutMs?: number;
    readonly maxReplyBytes?: number;
    readonly observe?: (options: OwnedProviderProcessSpawnOptions) => void;
  } = {},
) =>
  new BinaryNinjaHeadlessSessionClient({
    target,
    installation,
    bridgeScriptPath,
    startupTimeoutMs: options.startupTimeoutMs ?? 20_000,
    hostEnvironment: { PATH: process.env.PATH ?? "" },
    launcher: fixtureLauncher(mode, options.observe),
    maxReplyBytes: options.maxReplyBytes,
  });

const unwrap = <T, E extends Error>(
  result: { ok: true; value: T } | { ok: false; error: E },
): T => {
  if (!result.ok) throw result.error;
  return result.value;
};

const expectFailure = <E extends Error>(
  result: { ok: true; value: unknown } | { ok: false; error: Error },
  expected: new (...parameters: never[]) => E,
): E => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a failure");
  expect(result.error).toBeInstanceOf(expected);
  return result.error as E;
};

describe("Binary Ninja headless inventories", () => {
  it("starts the bridge under the isolated interpreter contract", async () => {
    const target = await createTarget();
    let launch: OwnedProviderProcessSpawnOptions | undefined;
    const client = createClient(target, "normal", {
      observe: (options) => (launch = options),
    });
    try {
      const health = unwrap(await client.execute("health", {}));
      expect(launch).toMatchObject({
        command: installation.pythonPath,
        arguments: [
          "-I",
          "-u",
          bridgeScriptPath,
          "--api-dir",
          installation.apiDir,
        ],
        env: BINARY_NINJA_BRIDGE_ENVIRONMENT,
        stdin: "pipe",
      });
      expect(health.result).toMatchObject({
        ready: true,
        engine: {
          core_version: "6.0.10905",
          user_plugins_disabled: true,
          user_settings_disabled: true,
        },
        function_count: 2,
      });
      const documents = unwrap(await client.execute("list_documents", {}));
      expect(documents.result).toEqual([target.path]);
    } finally {
      expect(await client.close()).toMatchObject({ ok: true });
    }
  });

  it("lists and searches procedures and strings with typed rows", async () => {
    const target = await createTarget();
    const client = createClient(target);
    try {
      const procedures = unwrap(await client.execute("list_procedures", {}));
      expect(procedures.result).toEqual([
        {
          address: "0x140001000",
          value: "main",
          symbol: {
            primary: true,
            dynamic: false,
            external: false,
            type: "FunctionSymbol",
            source: "user_defined",
          },
          procedure: { external: false, thunk: false, thunk_target: null },
        },
        {
          address: "0x140001100",
          value: "sub_140001100",
          symbol: {
            primary: true,
            dynamic: false,
            external: false,
            type: "FunctionSymbol",
            source: "default",
          },
          procedure: { external: false, thunk: false, thunk_target: null },
        },
      ]);
      expect(procedures.locations).toEqual([
        { kind: "artifact-path", path: target.path },
      ]);
      expect(procedures.cachePolicy).toBeUndefined();
      expect(procedures.rawResult).toMatchObject({
        engine: { core_version: "6.0.10905" },
      });
      const strings = unwrap(await client.execute("list_strings", {}));
      expect(strings.result).toEqual([
        {
          address: "0x14000a000",
          value: "hello",
          string: {
            encoding: "ascii",
            encoding_status: "observed",
            termination: "present_or_not_required",
            byte_length: 5,
          },
        },
        {
          address: "0x14000a010",
          value: "wörld",
          string: {
            encoding: "utf-16",
            encoding_status: "observed",
            termination: "present_or_not_required",
            byte_length: 10,
          },
        },
      ]);
      const one = unwrap(
        await client.execute("list_strings", { address: "0x14000A010" }),
      );
      expect(one.result).toEqual([expect.objectContaining({ value: "wörld" })]);
      const regex = unwrap(
        await client.execute("search_strings", {
          pattern: "W.RLD",
          mode: "regex",
        }),
      );
      expect(regex.result).toEqual([
        expect.objectContaining({ value: "wörld" }),
      ]);
      const literal = unwrap(
        await client.execute("search_procedures", { pattern: "MAIN" }),
      );
      expect(literal.result).toEqual([
        expect.objectContaining({ value: "main" }),
      ]);
    } finally {
      expect(await client.close()).toMatchObject({ ok: true });
    }
  });
});

describe("Binary Ninja headless function observations", () => {
  it("serves selectors, text and raw instruction windows", async () => {
    const target = await createTarget();
    const client = createClient(target);
    try {
      const address = unwrap(
        await client.execute("procedure_address", { procedure: "main" }),
      );
      expect(address.result).toBe("0x140001000");
      expect(address.locations).toContainEqual({
        kind: "address",
        address: "0x140001000",
      });
      const pseudo = unwrap(
        await client.execute("procedure_pseudo_code", {
          procedure: "0x140001000",
        }),
      );
      expect(pseudo.result).toContain("return sub_140001100();");
      const assembly = unwrap(
        await client.execute("procedure_assembly", { procedure: "main" }),
      );
      expect(assembly.result).toBe(
        "0x140001000: sub     rsp, 0x28\n0x140001004: call    sub_140001100",
      );
      const window = unwrap(
        await client.execute("read_function_instructions", {
          procedure: "main",
        }),
      );
      expect(window.result).toMatchObject({
        procedure: {
          address: "0x140001000",
          body: { available: true, non_contiguous: true, total_bytes: 80 },
        },
        instructions: [
          "0x140001000: sub     rsp, 0x28",
          "0x140001004: call    sub_140001100",
        ],
      });
    } finally {
      expect(await client.close()).toMatchObject({ ok: true });
    }
  });

  it("reports relationships with explicit coverage and a strict dossier", async () => {
    const target = await createTarget();
    const client = createClient(target);
    try {
      const callers = unwrap(
        await client.execute("procedure_callers", {
          procedure: "sub_140001100",
        }),
      );
      expect(callers.result).toEqual(["0x140001000"]);
      expect(callers.relationshipCoverage).toMatchObject({
        status: "unknown",
        limited_directions: ["callers"],
      });
      const callees = unwrap(
        await client.execute("procedure_callees", { procedure: "main" }),
      );
      expect(callees.result).toEqual(["0x140001100", "0x14000a298"]);
      expect(callees.relationshipCoverage).toMatchObject({
        status: "partial",
        limited_directions: ["callees"],
      });
      const dossier = unwrap(
        await client.execute("analyze_function", { procedure: "main" }),
      );
      const parsed = functionDossierSchema.parse(dossier.result);
      expect(parsed.procedure.signature).toBe("int32_t main()");
      expect(parsed.procedure.locals).toEqual([
        {
          description: "int32_t var_18",
          provenance: "binaryninja-function-variables",
          name: "var_18",
          stack_displacement: "-24",
        },
        {
          description: "int64_t rax",
          provenance: "binaryninja-function-variables",
          name: "rax",
        },
      ]);
      expect(
        parsed.callees.map(({ address, name, classification }) => [
          address,
          name,
          classification?.external,
        ]),
      ).toEqual([
        ["0x140001100", "sub_140001100", false],
        ["0x14000a298", "Sleep", true],
      ]);
      expect(parsed.unresolved_calls).toEqual([
        {
          address: "0x140001030",
          reason: "Binary Ninja resolved no target for this call site.",
        },
      ]);
      expect(parsed.outgoing_references).toHaveLength(2);
      expect(parsed.outgoing_references[1]?.kind).toMatchObject({
        available: false,
      });
      expect(parsed.referenced_strings).toEqual([
        expect.objectContaining({
          address: "0x14000a000",
          value: "hello",
          source_address: "0x140001010",
        }),
      ]);
      expect(parsed.referenced_names).toEqual([
        {
          address: "0x14000a298",
          value: "Sleep",
          source_address: "0x140001020",
        },
      ]);
      expect(parsed.comments).toEqual([
        { address: "0x140001000", kind: "comment", text: "entry" },
      ]);
      expect(dossier.relationshipCoverage).toMatchObject({
        status: "unknown",
        limited_directions: ["callers", "callees"],
      });
    } finally {
      expect(await client.close()).toMatchObject({ ok: true });
    }
  });
});

describe("Binary Ninja headless address observations", () => {
  it("resolves address references and containing procedures", async () => {
    const target = await createTarget();
    const client = createClient(target);
    try {
      const xrefs = unwrap(
        await client.execute("xrefs", { address: "0x140001100" }),
      );
      expect(xrefs.result).toEqual(["0x140001004", "0x14000c000"]);
      const inside = unwrap(
        await client.execute("resolve_containing_procedure", {
          address: "0x140001058",
        }),
      );
      expect(inside.result).toMatchObject({
        found: true,
        procedure: { address: "0x140001000" },
      });
      const gap = unwrap(
        await client.execute("resolve_containing_procedure", {
          address: "0x140001048",
        }),
      );
      expect(gap.result).toMatchObject({
        found: false,
        reason: "not_in_procedure",
      });
      const outside = unwrap(
        await client.execute("resolve_containing_procedure", {
          address: "0x10",
        }),
      );
      expect(outside.result).toMatchObject({
        found: false,
        reason: "outside_segments",
      });
    } finally {
      expect(await client.close()).toMatchObject({ ok: true });
    }
  });
});

describe("Binary Ninja headless caller mistakes", () => {
  it("rejects unsupported operations and malformed input before startup", async () => {
    const target = await createTarget();
    const client = createClient(target);
    try {
      expectFailure(
        await client.execute("set_comment", { address: "0x1", comment: "x" }),
        AnalysisCapabilityUnavailableError,
      );
      const missing = expectFailure(
        await client.execute("xrefs", {}),
        AnalysisInputError,
      );
      expect(missing.issues).toEqual([
        {
          path: ["address"],
          reason: "missing_argument",
          message: expect.stringContaining("0x-prefixed"),
        },
      ]);
      expectFailure(
        await client.execute("list_procedures", { document: "other.exe" }),
        AnalysisInputError,
      );
      expectFailure(
        await client.execute("search_strings", { pattern: "(", mode: "regex" }),
        AnalysisInputError,
      );
    } finally {
      expect(await client.close()).toMatchObject({ ok: true });
    }
  });

  it("keeps unresolved caller selectors as input errors and provider selectors as faults", async () => {
    const target = await createTarget();
    const client = createClient(target);
    try {
      const unknown = expectFailure(
        await client.execute("procedure_pseudo_code", { procedure: "nope" }),
        AnalysisInputError,
      );
      expect(unknown.issues[0]).toMatchObject({
        path: ["procedure"],
        reason: "invalid_value",
        message: expect.stringContaining("nope"),
      });
      const providerSelector = await client.execute(
        "procedure_pseudo_code",
        { procedure: "nope" },
        { selectorOrigin: "provider" },
      );
      expect(providerSelector.ok).toBe(false);
      if (!providerSelector.ok)
        expect(providerSelector.error).not.toBeInstanceOf(AnalysisInputError);
    } finally {
      expect(await client.close()).toMatchObject({ ok: true });
    }
  });
});

describe("Binary Ninja headless startup failures", () => {
  it.each([
    ["fatal", ProviderAdapterError, "could not be imported"],
    ["digest-mismatch", AnalysisArtifactChangedError, "do not match"],
    ["view-mismatch", AnalysisUnsupportedTargetError, "Mapped"],
    ["crash-after-ready", ProviderAdapterError, "exited"],
    ["exit-during-open", ProviderAdapterError, "exited"],
  ] as const)(
    "attributes %s startup failures and allows a retry",
    async (mode, expected, text) => {
      const target = await createTarget();
      const client = createClient(target, mode);
      try {
        const outcome = await client.execute("list_procedures", {});
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.error).toBeInstanceOf(expected);
        expect(
          outcome.error.message + (outcome.error.userMessage ?? ""),
        ).toContain(text);
        // The failed attempt is not cached: the next request starts afresh.
        const again = await client.execute("list_procedures", {});
        expect(again.ok).toBe(false);
        if (!again.ok) expect(again.error).toBeInstanceOf(expected);
      } finally {
        expect(await client.close()).toMatchObject({ ok: true });
      }
    },
  );
});

describe("Binary Ninja headless lifecycle", () => {
  it("times out startup under the configured deadline and names the setting", async () => {
    const target = await createTarget();
    const client = createClient(target, "hang", { startupTimeoutMs: 300 });
    try {
      const failure = expectFailure(
        await client.execute("list_procedures", {}),
        AnalysisTimeoutError,
      );
      expect(failure.remediationAction).toContain(
        "REA_BINARY_NINJA_STARTUP_TIMEOUT_MS",
      );
    } finally {
      expect(await client.close()).toMatchObject({ ok: true });
    }
  });

  it("stops the interpreter when the caller cancels during load, then recovers", async () => {
    const target = await createTarget();
    const client = createClient(target, "slow-open");
    try {
      const controller = new AbortController();
      const pending = client.execute(
        "list_procedures",
        {},
        {
          signal: controller.signal,
        },
      );
      setTimeout(() => controller.abort(new Error("caller moved on")), 50);
      expectFailure(await pending, AnalysisCancelledError);
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null)
          await once(child, "exit");
      const recovered = unwrap(await client.execute("list_procedures", {}));
      expect(recovered.result).toHaveLength(2);
    } finally {
      expect(await client.close()).toMatchObject({ ok: true });
    }
  });

  it("fails a request whose bridge breaks the protocol and restarts afterwards", async () => {
    const target = await createTarget();
    const client = createClient(target, "invalid-line");
    try {
      expect(
        unwrap(await client.execute("list_procedures", {})).result,
      ).toHaveLength(2);
      const broken = expectFailure(
        await client.execute("procedure_address", { procedure: "main" }),
        ProviderAdapterError,
      );
      expect(broken.diagnostics).toMatchObject({ bridge_stage: "protocol" });
      expect(
        unwrap(await client.execute("list_procedures", {})).result,
      ).toHaveLength(2);
    } finally {
      expect(await client.close()).toMatchObject({ ok: true });
    }
  });

  it("bounds reply size as a resource constraint", async () => {
    const target = await createTarget();
    const client = createClient(target, "oversized", { maxReplyBytes: 1024 });
    try {
      expect(unwrap(await client.execute("list_documents", {})).result).toEqual(
        [target.path],
      );
      expectFailure(
        await client.execute("procedure_address", { procedure: "main" }),
        AnalysisResourceConstraintError,
      );
    } finally {
      expect(await client.close()).toMatchObject({ ok: true });
    }
  });

  it("refuses work after close and keeps close idempotent", async () => {
    const target = await createTarget();
    const client = createClient(target);
    expect(unwrap(await client.execute("list_documents", {})).result).toEqual([
      target.path,
    ]);
    expect(await client.close()).toMatchObject({ ok: true });
    expect(await client.close()).toMatchObject({ ok: true });
    expectFailure(
      await client.execute("list_documents", {}),
      ProviderAdapterError,
    );
    for (const child of children)
      expect(child.exitCode ?? child.signalCode).not.toBeNull();
  });
});
