import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
const now = () => performance.now();

function collectText(stream, budget, overflow) {
  let output = "",
    bytes = 0;
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    bytes += Buffer.byteLength(chunk, "utf8");
    if (bytes > budget) {
      overflow();
      return;
    }
    output += chunk;
  });
  return () => output;
}

export function profileSelfTest() {
  const stream = new PassThrough();
  const text = collectText(stream, 3, () =>
    assert.fail("Unexpected byte overflow"),
  );
  const bytes = Buffer.from("类");
  stream.write(bytes.subarray(0, 1));
  stream.end(bytes.subarray(1));
  assert.equal(text(), "类", "Decode split UTF-8 without replacement");
  const bounded = new PassThrough();
  let overflow = false;
  const partial = collectText(bounded, 2, () => {
    overflow = true;
  });
  bounded.end(bytes);
  assert(overflow, "Bound decoded UTF-8 by bytes, not JS characters");
  assert.equal(partial(), "", "Do not retain over-budget chunks");
}

export function processCpuSeconds(value) {
  const [days, clock] = value.includes("-") ? value.split("-") : ["0", value];
  return (
    Number(days) * 86400 +
    clock.split(":").reduce((total, part) => total * 60 + Number(part), 0)
  );
}

function processes() {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,time=,lstart="], {
    encoding: "utf8",
  });
  return output
    .trim()
    .split("\n")
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
      assert(match, "Unexpected ps output");
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        rss_kib: Number(match[3]),
        cpu_seconds: processCpuSeconds(match[4]),
        identity: `${match[1]}:${match[5]}`,
      };
    });
}

function profileSnapshot(config, samples, cpu, known) {
  const remaining = processes().filter((row) => known.has(row.identity));
  return {
    method: "ps PID/PPID ancestry with retained pid+lstart identities",
    requested_interval_ms: config.sample_interval_ms,
    actual_max_interval_ms: samples
      .slice(1)
      .reduce(
        (max, sample, index) =>
          Math.max(max, sample.elapsed_ms - samples[index].elapsed_ms),
        0,
      ),
    peak_sampled_family_rss_kib: Math.max(
      0,
      ...samples.map((sample) => sample.rss_kib),
    ),
    observed_family_cpu_seconds_lower_bound: [...cpu.values()].reduce(
      (sum, value) => sum + value,
      0,
    ),
    remaining_observed_processes: remaining,
    samples,
    limitations: [
      "RSS is sampled, not a kernel high-water mark; short-lived or between-sample peaks can be missed",
      "Summed RSS double-counts shared pages; family CPU omits unobserved short-lived children",
      "The separate benchmark supervisor, oracle, ps sampler and OS file cache are excluded",
      "CPU values from ps are rounded; sampling perturbs execution; no hard OS memory cap is installed",
    ],
  };
}

export async function measuredWorker(config, entrypoint, root) {
  const started = now();
  const child = spawn(
    process.execPath,
    [entrypoint, "--worker", JSON.stringify(config)],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  const known = new Set(),
    cpu = new Map(),
    samples = [];
  let samplingError = null,
    guard = null,
    busy = false,
    stderrTruncated = false;
  const stdout = collectText(child.stdout, config.max_output_bytes, () =>
    stop("worker-output-budget"),
  );
  const stderr = collectText(child.stderr, 1024 * 1024, () => {
    stderrTruncated = true;
  });
  function stop(reason) {
    if (guard !== null) return;
    guard = reason;
    child.kill("SIGTERM");
  }
  function sample() {
    if (busy) return;
    busy = true;
    try {
      const rows = processes(),
        family = new Set([child.pid]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of rows)
          if (
            !family.has(row.pid) &&
            (family.has(row.ppid) || known.has(row.identity))
          ) {
            family.add(row.pid);
            changed = true;
          }
      }
      const live = rows.filter((row) => family.has(row.pid));
      for (const row of live) {
        known.add(row.identity);
        cpu.set(
          row.identity,
          Math.max(cpu.get(row.identity) ?? 0, row.cpu_seconds),
        );
      }
      const rss = live.reduce((sum, row) => sum + row.rss_kib, 0);
      samples.push({
        elapsed_ms: now() - started,
        rss_kib: rss,
        process_count: live.length,
      });
      if (rss > config.max_rss_mib * 1024) stop("sampled-family-rss-budget");
    } catch (error) {
      samplingError = String(error);
      stop("sampler-failure");
    } finally {
      busy = false;
    }
  }
  sample();
  const interval = setInterval(sample, config.sample_interval_ms);
  const deadline = setTimeout(
    () => stop("worker-wall-time-budget"),
    config.timeout_ms,
  );
  const completed = await new Promise((resolveCompletion, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveCompletion({ code, signal }));
  }).finally(() => {
    clearInterval(interval);
    clearTimeout(deadline);
  });
  const elapsed = now() - started;
  let result = null,
    parseError = null;
  try {
    result = JSON.parse(stdout());
  } catch (error) {
    parseError = String(error);
  }
  return {
    ...config,
    completion: completed,
    wall_ms: elapsed,
    guard,
    sampling_error: samplingError,
    parse_error: parseError,
    result,
    stderr: stderr(),
    stderr_truncated: stderrTruncated,
    profile: profileSnapshot(config, samples, cpu, known),
  };
}
