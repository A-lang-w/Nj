import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile, mkdir, stat } from "node:fs/promises";
import os from "node:os";
import { dirname, resolve, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  hashFile,
  oracle,
  verifyAscClassOracle,
  oracleSelfTest,
} from "./benchmark-oracle.mjs";
import {
  measuredWorker,
  processCpuSeconds,
  profileSelfTest,
} from "./benchmark-profile.mjs";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), "../..");
const now = () => performance.now();
const json = (value) => JSON.stringify(value, null, 2) + "\n";

export function exactClassHits(names, query) {
  return names.filter((name) => name === query).sort();
}

async function runtimeFingerprint() {
  const paths = [
    "dist/application/android/AndroidAnalysisService.js",
    "dist/android/JadxProvider.js",
    "dist/android/AscProvider.js",
    "dist/android/AscProtocol.js",
    "dist/android/AscConfiguration.js",
    "dist/composition/android.js",
    "dist/application/android/AndroidBackendRouter.js",
    "bridge/android/ReaJadxBridge.java",
    "bridge/android/rea_asc.py",
    "experiments/droidasc/benchmark.mjs",
    "experiments/droidasc/benchmark-oracle.mjs",
    "experiments/droidasc/benchmark-profile.mjs",
  ];
  return await Promise.all(
    paths.map(async (path) => ({
      path,
      sha256: await hashFile(join(ROOT, path)),
    })),
  );
}

function options(args) {
  const selected = {};
  for (let index = 0; index < args.length; index += 2) {
    assert(
      args[index]?.startsWith("--") && args[index + 1] !== undefined,
      "Each option requires a value",
    );
    selected[args[index].slice(2)] = args[index + 1];
  }
  return selected;
}

async function worker(config) {
  const started = now(),
    phases = [],
    results = [];
  let provider,
    service,
    closeError = null,
    failure = null;
  const phase = async (name, action) => {
    const at = now(),
      usage = process.cpuUsage();
    try {
      return await action();
    } finally {
      const used = process.cpuUsage(usage),
        end = now();
      phases.push({
        name,
        start_ms: at - started,
        end_ms: end - started,
        wall_ms: end - at,
        worker_cpu_seconds: (used.user + used.system) / 1e6,
      });
    }
  };
  const cancellation = new AbortController();
  process.once("SIGTERM", () =>
    cancellation.abort(new Error("benchmark guard cancelled workflow")),
  );
  try {
    const { AndroidAnalysisService } =
      await import("../../dist/application/android/AndroidAnalysisService.js");
    assert(["asc", "jadx"].includes(config.backend), "Choose jadx or asc");
    const { createAndroidAnalysisProvider } =
      await import("../../dist/composition/android.js");
    provider = createAndroidAnalysisProvider({
      ...process.env,
      REA_JADX_MCP_JAR: config.jadx_jar,
      JAVA_HOME: config.java_home,
      REA_JADX_HEAP_MIB: String(config.jadx_heap_mib),
      REA_JADX_OPERATION_TIMEOUT_MS: String(config.timeout_ms),
      REA_ASC_PYTHON: config.python,
      REA_ASC_OPERATION_TIMEOUT_MS: String(config.timeout_ms),
      REA_ASC_MAX_APK_BYTES: String(config.max_apk_bytes),
      REA_ASC_MAX_DEX_BYTES: String(config.max_dex_bytes),
      REA_ASC_MAX_OUTPUT_BYTES: String(config.max_output_bytes),
    });
    service = new AndroidAnalysisService(provider);
    phases.push({
      name: "worker-import-and-construction",
      start_ms: 0,
      end_ms: now() - started,
      wall_ms: now() - started,
    });
    for (let index = 0; index <= config.warm_runs; index++) {
      const value = await phase(
        index === 0 ? "first-query-in-fresh-worker" : `repeat-query-${index}`,
        () =>
          service.execute(
            "search_android_classes",
            { path: config.apk, query: config.query, backend: config.backend },
            { signal: cancellation.signal },
          ),
      );
      results.push(value);
      if (!value.ok) break;
    }
  } catch (error) {
    failure = { message: String(error), stack: error?.stack ?? null };
  } finally {
    if (provider) {
      try {
        await phase("provider-close", () => provider.close());
      } catch (error) {
        closeError = String(error);
      }
    }
  }
  const usage = process.resourceUsage();
  process.stdout.write(
    JSON.stringify({
      backend: config.backend,
      phases,
      results,
      failure,
      close_error: closeError,
      worker_cpu_seconds: (usage.userCPUTime + usage.systemCPUTime) / 1e6,
      worker_max_rss_kib: usage.maxRSS,
      reuse:
        config.backend === "jadx"
          ? "One real REA AndroidAnalysisService/JadxProvider; repeated queries reuse its validated retained JVM session"
          : "One real REA AndroidAnalysisService/AscProvider with a fresh Python worker per request; only the Node service is warm",
      phase_limitations: [
        "First query combines target admission, input hashing, provider/engine initialization, indexing, projection and Evidence; these internal subphases are not independently instrumented",
        "Per-phase CPU covers the Node worker only; use sampled family total for the engine plus worker",
      ],
    }),
  );
  if (failure || closeError) process.exitCode = 1;
}

function checkedResult(observation, query, expected, independent) {
  assert.equal(observation.guard, null, "No benchmark resource stop");
  assert.equal(observation.completion.code, 0, "Worker exit status");
  assert.equal(observation.parse_error, null, "Worker JSON");
  assert.equal(
    observation.profile.remaining_observed_processes.length,
    0,
    "No observed descendants remain",
  );
  assert.equal(observation.result.failure, null, "Worker workflow");
  assert.equal(observation.result.close_error, null, "Provider cleanup");
  const checked = observation.result.results.map((value) => {
    assert(value.ok, `Provider error: ${JSON.stringify(value.error)}`);
    assert.equal(
      value.value.subject.digest.sha256,
      observation.sha256,
      "Evidence APK SHA-256",
    );
    assert.equal(
      value.value.provider.id,
      observation.backend,
      "Selected provider identity",
    );
    const normalized = value.value.normalized_result;
    assert.equal(normalized.coverage, "complete");
    const names = normalized.matches,
      total = normalized.total_classes,
      identity = value.value.provider;
    const scope =
      observation.backend === "jadx"
        ? "JADX bridge class inventory; not guaranteed to equal raw DEX class_def inventory"
        : "Raw root-DEX class_def definitions; not equivalent to JADX's rewritten/top-level inventory";
    const hits = exactClassHits(names, query);
    if (observation.backend === "asc")
      assert.deepEqual(
        [...names].sort(),
        verifyAscClassOracle(value.value.raw_result, independent, query),
        "Normalized ASC query agrees with source definitions",
      );
    assert.deepEqual(
      hits,
      expected,
      "Exact selected class agrees with independent DEX class_def oracle",
    );
    return {
      exact_hits: hits,
      returned_matches: names,
      reported_inventory_total: total,
      scope,
      provider: identity,
    };
  });
  assert.equal(
    checked.length,
    observation.warm_runs + 1,
    "All requested repeats completed",
  );
  return checked;
}

function benchmarkConfiguration(selected, target) {
  const { apk, before, query, descriptor } = target;
  const config = {
    apk,
    sha256: before,
    query,
    descriptor,
    python: selected.python ?? "python3",
    jadx_jar: resolve(
      selected["jadx-jar"] ??
        "_reference/apk-integration/jadx-headless-mcp-0.7.1-all.jar",
    ),
    java_home: selected["java-home"] ?? process.env.JAVA_HOME,
    jadx_heap_mib: Number(selected["jadx-heap-mib"] ?? 2048),
    max_apk_bytes: Number(selected["max-apk-bytes"] ?? 256 * 1024 * 1024),
    max_dex_bytes: Number(selected["max-dex-bytes"] ?? 512 * 1024 * 1024),
    max_output_bytes: Number(selected["max-output-bytes"] ?? 32 * 1024 * 1024),
    max_rss_mib: Number(selected["max-rss-mib"] ?? 4096),
    timeout_ms: Number(selected["timeout-ms"] ?? 300000),
    sample_interval_ms: Number(selected["sample-interval-ms"] ?? 25),
    warm_runs: Number(selected["warm-runs"] ?? 2),
  };
  const rounds = Number(selected.rounds ?? 3),
    backends = (selected.backends ?? "asc,jadx").split(",");
  for (const value of [
    rounds,
    config.warm_runs,
    config.sample_interval_ms,
    config.timeout_ms,
    config.max_apk_bytes,
    config.max_dex_bytes,
    config.max_output_bytes,
    config.max_rss_mib,
    config.jadx_heap_mib,
  ])
    assert(
      Number.isSafeInteger(value) && value > 0,
      "Positive integral benchmark options",
    );
  assert(rounds >= 3, "At least three alternating rounds are required");
  return { config, rounds, backends };
}

async function initialSummary(config, selected, sample) {
  const { info, independent, expected } = sample;
  const { apk, sha256: before, query, descriptor } = config;
  return {
    schema_version: 1,
    started_at: new Date().toISOString(),
    revision: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim(),
    harness_sha256: await hashFile(SELF),
    environment: {
      platform: process.platform,
      architecture: process.arch,
      os_release: os.release(),
      cpu_model: os.cpus()[0]?.model ?? null,
      logical_cpus: os.cpus().length,
      total_memory_bytes: os.totalmem(),
      node: process.version,
    },
    sample: {
      path: apk,
      sha256: before,
      bytes: info.size,
      source_url: selected["source-url"] ?? null,
    },
    task: {
      description:
        "Discover one exact named top-level class using the provider's substring query then exact selection; compare identical oracle-confirmed hits, not unequal whole class inventories",
      query,
      descriptor,
      expected_exact_hits: expected,
      oracle_raw_definition_count: independent.dexes.reduce(
        (sum, dex) => sum + dex.descriptors.length,
        0,
      ),
      oracle_dexes: independent.dexes.map(
        ({ descriptors: _descriptors, ...identity }) => identity,
      ),
    },
    cache_conditions: [
      "Fresh Node worker and provider for every recorded backend/round",
      "JADX repeat queries reuse the same retained JVM; ASC reuse is reported by its worker and observable process samples",
      "OS disk/page caches are NOT flushed; fresh-process does not mean cold filesystem cache",
      "Backend order alternates each round; sampler and host load may affect timings",
    ],
    jadx_jar_sha256: await hashFile(config.jadx_jar),
    runtime_fingerprint_scope:
      "Selected built/shared-service/provider and bridge entrypoints, not the entire transitive dependency tree or executed-byte identity",
    runtime_file_hashes_before: await runtimeFingerprint(),
    runs: [],
    complete: false,
    failures: [],
  };
}

async function recordRun(config, summary, output, independent) {
  assert.equal(
    await hashFile(config.apk),
    config.sha256,
    "APK unchanged before each run",
  );
  const rawFile = `${config.round}-${config.backend}.json`;
  process.stderr.write(
    `round ${config.round} ${config.backend}: ${config.apk}\n`,
  );
  const observation = await measuredWorker(config, SELF, ROOT);
  await writeFile(join(output, rawFile), json(observation));
  let correctness = null,
    failure = null;
  try {
    assert.deepEqual(
      await runtimeFingerprint(),
      summary.runtime_file_hashes_before,
      "Benchmark runtime entrypoint files unchanged during runs",
    );
    correctness = checkedResult(
      observation,
      config.query,
      summary.task.expected_exact_hits,
      independent,
    );
  } catch (error) {
    failure = String(error);
    summary.failures.push({
      round: config.round,
      backend: config.backend,
      failure,
    });
  }
  summary.runs.push({
    backend: config.backend,
    round: config.round,
    raw_file: rawFile,
    wall_ms: observation.wall_ms,
    phases: observation.result?.phases ?? [],
    peak_sampled_family_rss_kib:
      observation.profile.peak_sampled_family_rss_kib,
    observed_family_cpu_seconds_lower_bound:
      observation.profile.observed_family_cpu_seconds_lower_bound,
    correctness,
    failure,
  });
  summary.sample.sha256_after = await hashFile(config.apk);
  assert.equal(
    summary.sample.sha256_after,
    config.sha256,
    "APK unchanged after each run",
  );
  await writeFile(join(output, "summary.json"), json(summary));
}

async function main(selected) {
  assert(
    selected.apk && selected.query && selected.output,
    "Usage: node benchmark.mjs --apk ABS --query dotted.TopLevelClass --output ABS [--python PYTHON --jadx-jar ABS --java-home ABS --rounds 3 --warm-runs 2 --backends asc,jadx]",
  );
  const apk = resolve(selected.apk),
    output = resolve(selected.output),
    query = selected.query;
  assert(
    !query.includes("$") && query.includes("."),
    "Select an exact named top-level class, not an inner class",
  );
  await mkdir(output, { recursive: true });
  const before = await hashFile(apk),
    info = await stat(apk),
    descriptor = `L${query.replaceAll(".", "/")};`;
  if (selected["expected-sha256"])
    assert.equal(
      before,
      selected["expected-sha256"],
      "Caller-pinned APK digest",
    );
  const { config, rounds, backends } = benchmarkConfiguration(selected, {
    apk,
    before,
    query,
    descriptor,
  });
  assert(
    info.size <= config.max_apk_bytes,
    "APK byte budget before oracle allocation",
  );
  const independent = await oracle(apk, config.max_dex_bytes);
  const expected = independent.dexes
    .flatMap((dex) => dex.descriptors.filter((value) => value === descriptor))
    .map(() => query)
    .sort();
  assert(
    expected.length > 0,
    "Selected exact class must exist in independent DEX oracle",
  );
  await writeFile(join(output, "oracle.json"), json(independent));
  const summary = await initialSummary(config, selected, {
    info,
    independent,
    expected,
  });
  await writeFile(join(output, "summary.json"), json(summary));
  for (let round = 0; round < rounds; round++) {
    const order = round % 2 === 0 ? backends : [...backends].reverse();
    for (const backend of order) {
      await recordRun(
        { ...config, backend, round: round + 1 },
        summary,
        output,
        independent,
      );
    }
  }
  assert.equal(
    await hashFile(config.jadx_jar),
    summary.jadx_jar_sha256,
    "JADX JAR unchanged",
  );
  summary.finished_at = new Date().toISOString();
  summary.runtime_file_hashes_after = await runtimeFingerprint();
  summary.complete = summary.failures.length === 0;
  await writeFile(join(output, "summary.json"), json(summary));
  process.stdout.write(
    json({
      complete: summary.complete,
      failures: summary.failures,
      summary: join(output, "summary.json"),
    }),
  );
  if (!summary.complete) process.exitCode = 1;
}

function selfTest() {
  oracleSelfTest();
  profileSelfTest();
  assert.deepEqual(
    exactClassHits(["demo.A", "demo.A$Inner", "demo.AA"], "demo.A"),
    ["demo.A"],
  );
  assert.equal(processCpuSeconds("01:02.50"), 62.5);
  assert.equal(processCpuSeconds("1-02:03:04"), 93784);

  assert.throws(
    () =>
      checkedResult(
        {
          guard: null,
          completion: { code: 0 },
          parse_error: null,
          profile: { remaining_observed_processes: [] },
          result: {
            failure: null,
            close_error: null,
            results: [{ ok: false, error: { reason: "producer-failure" } }],
          },
          warm_runs: 2,
          backend: "asc",
        },
        "x",
        ["x"],
      ),
    /producer-failure/,
  );
  process.stdout.write("benchmark self-test passed\n");
}

if (process.argv[1] === SELF) {
  if (process.argv.includes("--self-test")) selfTest();
  else if (process.argv[2] === "--worker")
    await worker(JSON.parse(process.argv[3]));
  else await main(options(process.argv.slice(2)));
}
