import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it as test, onTestFinished, vi } from "vitest";

import { AscProvider } from "../../../src/android/AscProvider.js";
import { AndroidAnalysisService } from "../../../src/application/android/AndroidAnalysisService.js";
import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../../../src/process/ProcessOwnership.js";
import { OwnedFileHandle } from "../../../src/filesystem/OwnedFileHandle.js";
import { writeOrderedZip } from "../../fixtures/artifactEntryOrder.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const it = test.skipIf(process.platform === "win32");

/** A real owned subprocess with the bridge's documented wire shape, not an ASC claim. */
const fixture = async (
  mode = "normal",
  settings: Readonly<Record<string, string>> = {},
  denyCleanup?: () => boolean,
  beforeCleanup?: () => Promise<void>,
) => {
  const root = await createTestTempDirectory("rea-asc-provider-");
  const apk = join(root, "fixture.apk");
  const worker = join(root, "producer.mjs");
  const marker = join(root, "started");
  await writeOrderedZip(apk, ["AndroidManifest.xml", "classes.dex"]);
  await writeFile(
    worker,
    `
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const field = name => args.find(arg=>arg.startsWith(name+"="))?.slice(name.length+1) ?? args[args.indexOf(name) + 1];
const operation = field("--operation");
const query = operation === "probe" ? undefined : JSON.parse(field("--query-json"));
const provider = {name:"droidasc",version:null,python_executable:process.execPath,
  fingerprint_scope:"Imported entry modules, not the complete dependency tree.",
  modules:[{name:"droidasc.fixture",path:${JSON.stringify(worker)},sha256:"${"b".repeat(64)}"}]};
const result = operation === "probe" ? {complete:true,provider,error:null} : {
  complete:true,input:{path:field("--apk"),sha256:field("--expected-sha256")},
  operation,query,provider,total_classes:4,
  coverage:{root_dex_entries:1,examined_entries:["classes.dex"],excluded_entries:1,
    scope:"Root ZIP DEX definitions; no embedded DEX, split merge or resources."},
  dexes:[{entry:"classes.dex",logical_name:"classes.dex",entry_sha256:"${"c".repeat(64)}",sha256:"${"c".repeat(64)}"}],
  classes:[{dex:0,descriptor:"Lfixture/Target;",name:"fixture.Target"},
    {dex:0,descriptor:"Lfixture/Target;",name:"fixture.Target"},
    {dex:0,descriptor:"Lfixture/Other;",name:"fixture.Other"},
    {dex:0,descriptor:"Lfixture/target;",name:"fixture.target"}]
    .filter(cls=>cls.name.includes(query)),occurrences:[],error:null};
const mode = ${JSON.stringify(mode)};
if (mode === "malformed") result.classes[0].dex = 9;
if (mode === "namespace") result.provider.modules.unshift({name:"droidasc",path:null,sha256:null});
if (mode === "wrong-identity") result.input.sha256 = "${"d".repeat(64)}";
if (mode === "incomplete") result.coverage.examined_entries = [];
if (mode === "unavailable") {result.complete=false; result.error={kind:"provider_unavailable",message:"missing reviewed ASC installation"};}
if (mode === "changed-target") writeFileSync(field("--apk"),"changed input");
if (mode === "output-limit") process.stdout.write("x".repeat(16384));
else if (mode === "stall") {writeFileSync(${JSON.stringify(marker)},"started");setInterval(()=>{},1000);}
else {process.stdout.write(JSON.stringify(result));process.exitCode=result.complete?0:1;}
`,
  );
  const launches: {
    readonly pid: number | undefined;
    readonly args: readonly string[];
  }[] = [];
  const provider = new AscProvider(
    { ...process.env, REA_ASC_PYTHON: process.execPath, ...settings },
    async (options) => {
      const spawned = await spawnOwnedProviderProcess({
        ...options,
        command: process.execPath,
        arguments: [worker, ...options.arguments.slice(2)],
        expectedCommand: process.execPath,
      });
      launches.push({ pid: spawned.process.pid, args: options.arguments });
      return denyCleanup === undefined && beforeCleanup === undefined
        ? spawned
        : {
            ...spawned,
            cleanup: async () => {
              await beforeCleanup?.();
              return denyCleanup?.()
                ? { cleaned: false, reason: "controlled ASC ownership denial" }
                : cleanupOwnedProcessGroup(spawned.ownership);
            },
          };
    },
  );
  onTestFinished(() => provider.close());
  return {
    provider,
    service: new AndroidAnalysisService(provider),
    apk,
    marker,
    launches,
  };
};

it("returns raw DEX definition matches and provenance without claiming JADX inventory equivalence", async () => {
  const { service, apk, launches } = await fixture();
  const result = await service.execute("search_android_classes", {
    path: apk,
    query: "Target",
  });
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    provider: { id: "asc", version: null },
    parameters: { path: apk, query: "Target" },
    subject: {
      digest: {
        sha256: createHash("sha256")
          .update(await readFile(apk))
          .digest("hex"),
      },
    },
    normalized_result: {
      inventory_kind: "dex_definitions",
      total_classes: 4,
      matches: ["fixture.Target", "fixture.Target"],
      duplicate_names: [{ name: "fixture.Target", occurrences: 2 }],
      coverage: "complete",
      engine: {
        name: "DroidASC",
        version: null,
        worker_count: 1,
        heap_limit_mib: null,
      },
    },
    raw_result: {
      dexes: [{ entry: "classes.dex" }],
      classes: [
        { descriptor: "Lfixture/Target;" },
        { descriptor: "Lfixture/Target;" },
      ],
    },
  });
  expect(launches[0]?.args).toContain("--expected-sha256");
  await expect(
    service.execute("inspect_android_method", {
      path: apk,
      class_name: "fixture.Target",
      method_name: "run",
    }),
  ).resolves.toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCapabilityUnavailableError", providerId: "asc" },
  });
  expect(launches).toHaveLength(1);
});

it.each(["malformed", "wrong-identity", "incomplete"])(
  "rejects %s producer facts instead of promoting them to complete Evidence",
  async (mode) => {
    const { service, apk } = await fixture(mode);
    await expect(
      service.execute("search_android_classes", { path: apk, query: "Target" }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisOutputError",
        partialObservation: expect.anything(),
      },
    });
  },
);

it.each([
  { query: "--help", matches: [] },
  { query: "-foo", matches: [] },
  { query: "\0", matches: [] },
  { query: "\ud800", matches: [] },
  {
    query: "",
    matches: [
      "fixture.Target",
      "fixture.Target",
      "fixture.Other",
      "fixture.target",
    ],
  },
])(
  "preserves literal option-like and empty substring $query at the Python argument boundary",
  async ({ query, matches }) => {
    const { service, apk, launches } = await fixture();
    const result = await service.execute("search_android_classes", {
      path: apk,
      query,
    });
    if (!result.ok) throw result.error;
    expect(result.value.normalized_result).toMatchObject({
      query,
      matches,
      coverage: "complete",
    });
    expect(launches[0]?.args).toContain(
      `--query-json=${JSON.stringify(query)}`,
    );
  },
);

it("reports a missing BYO Python and never tries to install or fall back to JADX", async () => {
  const provider = new AscProvider({});
  onTestFinished(() => provider.close());
  await expect(provider.inspectAvailability()).resolves.toMatchObject({
    status: "unavailable",
    code: "not_configured",
    reason: expect.stringContaining("REA_ASC_PYTHON"),
    diagnostics: {
      asc_availability_code: "not_configured",
      remediation_action: expect.stringContaining("REA_ASC_PYTHON"),
    },
  });
});

it.each([
  "REA_ASC_OPERATION_TIMEOUT_MS",
  "REA_ASC_MAX_APK_BYTES",
  "REA_ASC_MAX_DEX_BYTES",
  "REA_ASC_MAX_OUTPUT_BYTES",
])("rejects invalid %s before launch", async (name) => {
  const { service, provider, apk, launches } = await fixture("normal", {
    [name]: "0",
  });
  await expect(
    service.execute("search_android_classes", { path: apk, query: "Target" }),
  ).resolves.toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCapabilityUnavailableError" },
  });
  expect(launches).toHaveLength(0);
  await expect(provider.inspectAvailability()).resolves.toMatchObject({
    status: "unavailable",
    code: "open_options_invalid",
    diagnostics: {
      asc_availability_code: "open_options_invalid",
      setting: name,
      remediation_action: expect.stringContaining(name),
    },
  });
});

it.each([
  { python: "python-relative", code: "open_options_invalid" },
  { python: "/REA_MISSING_PYTHON_157c9d/python", code: "executable_missing" },
])(
  "preserves the configuration owner's $code availability classification",
  async ({ python, code }) => {
    const provider = new AscProvider({ REA_ASC_PYTHON: python });
    onTestFinished(() => provider.close());
    await expect(provider.inspectAvailability()).resolves.toMatchObject({
      status: "unavailable",
      code,
      diagnostics: {
        asc_availability_code: code,
        remediation_action: expect.stringContaining("REA_ASC_PYTHON"),
      },
    });
  },
);

it("reports the configuration owner's unsupported host without re-deriving it from Python settings", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  const provider = new AscProvider({ REA_ASC_PYTHON: process.execPath });
  try {
    await expect(provider.inspectAvailability()).resolves.toMatchObject({
      status: "unavailable",
      code: "unsupported_host",
      diagnostics: {
        asc_availability_code: "unsupported_host",
        platform: "win32",
      },
    });
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    await provider.close();
  }
});

it("probes the explicit interpreter's actual imports without loading a target", async () => {
  const { provider, launches } = await fixture();
  await expect(provider.inspectAvailability()).resolves.toMatchObject({
    status: "available",
    diagnostics: {
      provider: { version: null, modules: [{ name: "droidasc.fixture" }] },
    },
  });
  expect(launches[0]?.args).not.toContain("--apk");
});

it("keeps namespace modules' missing file identity explicit instead of inventing a digest", async () => {
  const { service, apk } = await fixture("namespace");
  const result = await service.execute("search_android_classes", {
    path: apk,
    query: "Target",
  });
  if (!result.ok) throw result.error;
  expect(result.value.raw_result).toMatchObject({
    provider: {
      modules: [
        { name: "droidasc", path: null, sha256: null },
        { name: "droidasc.fixture" },
      ],
    },
  });
});

it("reports absent ASC modules as a repairable optional dependency", async () => {
  const { service, provider, apk } = await fixture("unavailable");
  await expect(
    service.execute("search_android_classes", { path: apk, query: "Target" }),
  ).resolves.toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisCapabilityUnavailableError",
      providerId: "asc",
      remediationAction: expect.stringContaining("PYTHONPATH"),
    },
  });
  await expect(provider.inspectAvailability()).resolves.toMatchObject({
    status: "unavailable",
    code: "runtime_unavailable",
    diagnostics: { remediation_action: expect.stringContaining("PYTHONPATH") },
  });
});

it("rejects a changed admitted target before any producer acquisition", async () => {
  const { provider, apk, launches } = await fixture();
  const target = await parseBinaryTarget(apk);
  if (!target.ok) throw target.error;
  await writeFile(apk, "replacement input");
  await expect(
    provider.execute(target.value, {
      operation: "search_android_classes",
      input: { path: apk, query: "Target" },
    }),
  ).resolves.toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
  expect(launches).toHaveLength(0);
});

it("rejects post-worker target changes while retaining the producer observation", async () => {
  const { service, apk } = await fixture("changed-target");
  await expect(
    service.execute("search_android_classes", { path: apk, query: "Target" }),
  ).resolves.toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisInputError",
      partialObservation: {
        normalized_result: { matches: ["fixture.Target", "fixture.Target"] },
      },
    },
  });
});

it("preserves an opaque caller cancellation reason and releases the active owned process", async () => {
  const { service, apk, marker, launches } = await fixture("stall");
  const controller = new AbortController();
  const reason = { request: "cancel ASC" };
  const pending = service.execute(
    "search_android_classes",
    { path: apk, query: "Target" },
    { signal: controller.signal },
  );
  await expect
    .poll(() => readFile(marker, "utf8").catch(() => ""), { timeout: 10_000 })
    .toBe("started");
  controller.abort(reason);
  const result = await pending;
  if (result.ok) throw new Error("Expected cancellation");
  expect(result.error).toMatchObject({ _tag: "AnalysisCancelledError" });
  expect(result.error.cause).toBe(reason);
  expect(() => process.kill(-launches[0]!.pid!, 0)).toThrowError(
    expect.objectContaining({ code: "ESRCH" }),
  );
});

it("close cancels active and queued work and prevents replacement acquisition", async () => {
  const { service, provider, apk, marker, launches } = await fixture("stall");
  const first = service.execute("search_android_classes", {
    path: apk,
    query: "Target",
  });
  await expect
    .poll(() => readFile(marker, "utf8").catch(() => ""), { timeout: 10_000 })
    .toBe("started");
  const second = service.execute("search_android_classes", {
    path: apk,
    query: "Target",
  });
  await provider.close();
  for (const pending of [
    first,
    second,
    service.execute("search_android_classes", { path: apk, query: "Target" }),
  ])
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
  expect(launches).toHaveLength(1);
});

it.each([
  {
    mode: "stall",
    settings: { REA_ASC_OPERATION_TIMEOUT_MS: "1000" },
    tag: "AnalysisTimeoutError",
  },
  {
    mode: "output-limit",
    settings: { REA_ASC_MAX_OUTPUT_BYTES: "8192" },
    tag: "AnalysisResourceConstraintError",
  },
])(
  "classifies $mode without returning incomplete class-search success",
  async ({ mode, settings, tag }) => {
    const { service, apk } = await fixture(mode, settings);
    await expect(
      service.execute("search_android_classes", { path: apk, query: "Target" }),
    ).resolves.toMatchObject({ ok: false, error: { _tag: tag } });
  },
);

it("binds failed command cleanup to its exact owner, blocks replacement, and resolves it after retry", async () => {
  let denied = true;
  const { service, provider, apk, launches } = await fixture(
    "normal",
    {},
    () => denied,
  );
  try {
    const first = await service.execute("search_android_classes", {
      path: apk,
      query: "Target",
    });
    if (first.ok) throw new Error("Expected incomplete cleanup");
    expect(first.error).toMatchObject({
      cleanupIncomplete: true,
      partialObservation: {
        raw_result: {
          classes: [
            { descriptor: "Lfixture/Target;" },
            { descriptor: "Lfixture/Target;" },
          ],
        },
      },
    });
    const blocked = await service.execute("search_android_classes", {
      path: apk,
      query: "Target",
    });
    if (blocked.ok)
      throw new Error("Expected retained cleanup to block acquisition");
    expect(blocked.error.cleanupIncomplete).toBe(true);
    expect(launches).toHaveLength(1);
    denied = false;
    await provider.close();
    expect(first.error.cleanupIncomplete).toBe(false);
    expect(blocked.error.cleanupIncomplete).toBe(false);
  } finally {
    denied = false;
    await provider.close();
  }
});

it.each([false, true])(
  "joins final cleanup and preserves completed facts, cancelled=%s",
  async (cancelled) => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service, apk } = await fixture(
      "normal",
      {},
      undefined,
      async () => {
        enter();
        await barrier;
      },
    );
    const controller = new AbortController();
    const reason = { phase: "final cleanup" };
    const pending = service.execute(
      "search_android_classes",
      { path: apk, query: "Target" },
      { signal: controller.signal },
    );
    try {
      await entered;
      if (cancelled) controller.abort(reason);
    } finally {
      release();
    }
    const result = await pending;
    if (!cancelled) {
      if (!result.ok) throw result.error;
      expect(result.value.normalized_result).toMatchObject({
        matches: ["fixture.Target", "fixture.Target"],
      });
      return;
    }
    if (result.ok) throw new Error("Expected late cancellation");
    expect(result.error).toMatchObject({
      _tag: "AnalysisCancelledError",
      partialObservation: { raw_result: { complete: true } },
    });
    expect(result.error.cause).toBe(reason);
  },
);

it("retains a hash descriptor and the exact late cancellation reason until its owner closes", async () => {
  const { provider, apk, launches } = await fixture();
  const target = await parseBinaryTarget(apk);
  if (!target.ok) throw target.error;
  const controller = new AbortController();
  const reason = { stage: "hash descriptor final close" };
  const original = OwnedFileHandle.prototype.close;
  const owners: OwnedFileHandle[] = [];
  let denied = true;
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementation(async function (this: OwnedFileHandle) {
      owners.push(this);
      if (denied) {
        controller.abort(reason);
        throw new Error("controlled hash descriptor denial");
      }
      await original.call(this);
    });
  try {
    const result = await provider.execute(
      target.value,
      {
        operation: "search_android_classes",
        input: { path: apk, query: "Target" },
      },
      { signal: controller.signal },
    );
    if (result.ok) throw new Error("Expected failed descriptor cleanup");
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(result.error.cleanupPrimary).toMatchObject({
      _tag: "AnalysisCancelledError",
    });
    expect(result.error.cleanupPrimary?.cause).toBe(reason);
    expect(owners[0]?.handle.fd).toBeGreaterThanOrEqual(0);
    expect(launches).toHaveLength(0);
    denied = false;
    await provider.close();
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(owners[0]?.handle.fd).toBe(-1);
  } finally {
    denied = false;
    await provider.close();
    close.mockRestore();
  }
});

it.each([false, true])(
  "keeps invalid identity primary when cancellation follows output closure, cleanupDenied=%s",
  async (cleanupDenied) => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let denied = cleanupDenied;
    const { service, provider, apk } = await fixture(
      "wrong-identity",
      {},
      () => denied,
      async () => {
        enter();
        await barrier;
      },
    );
    const controller = new AbortController();
    const pending = service.execute(
      "search_android_classes",
      { path: apk, query: "Target" },
      { signal: controller.signal },
    );
    try {
      await entered;
      controller.abort({ stage: "after invalid producer output" });
      release();
      const result = await pending;
      if (result.ok) throw new Error("Expected invalid output");
      if (cleanupDenied) {
        expect(result.error.cleanupPrimary).toMatchObject({
          _tag: "AnalysisOutputError",
        });
        expect(result.error.cleanupIncomplete).toBe(true);
      } else
        expect(result.error).toMatchObject({ _tag: "AnalysisOutputError" });
      denied = false;
      await provider.close();
      expect(result.error.cleanupIncomplete).toBe(false);
    } finally {
      denied = false;
      release();
      await provider.close();
    }
  },
);
