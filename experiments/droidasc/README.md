# DroidASC class-discovery benchmark

On the tested 114 MB Signal APK, opt-in ASC answered the shared class-discovery
question with a **2.0× lower median first-query latency** and **6.9× lower sampled
process-family RSS** than JADX. Repeated queries were **17.6× slower**: ASC starts
a new Python worker each time, whereas JADX retains its loaded JVM. This supports
an optional cold-discovery backend, not replacing JADX or claiming general Android
analysis superiority. Maintainer scope approval for the proposal remains pending.

## Reproduce

Use the repository's pinned Node/npm toolchain, an existing full JDK, the pinned
JADX MCP JAR from `npm run fixtures:android`, and caller-supplied ASC source at
`60033d1c76bc5904588f24955cae4e83a2ba4f5d`. Nothing here installs engines or runs APK
code. Build with `npm run build:cached`, then:

```sh
PYTHONPATH=/absolute/path/to/ASC PYTHONDONTWRITEBYTECODE=1 \
node experiments/droidasc/benchmark.mjs \
  --apk /absolute/path/Signal-8.30.3.apk \
  --expected-sha256 9a8ddd9a2f3d7ddc6abca15eb41e5d1515f75d0bd8c45e22074767932a5dde20 \
  --source-url https://github.com/signalapp/Signal-Android/releases/download/v8.30.3/Signal-Android-github-prod-universal-release-8.30.3.apk \
  --query org.thoughtcrime.securesms.ApplicationContext \
  --python /absolute/path/to/python \
  --jadx-jar /absolute/path/jadx-headless-mcp-0.7.1-all.jar \
  --java-home /absolute/path/to/jdk \
  --jadx-heap-mib 2048 --max-rss-mib 4096 --timeout-ms 300000 \
  --max-apk-bytes 268435456 --max-dex-bytes 536870912 \
  --max-output-bytes 33554432 \
  --rounds 3 --warm-runs 2 --output /absolute/path/to/new-results
```

For the smaller control, use ApiDemos v6.0.18, digest below, and
`--query io.appium.android.apis.ApiDemos`. `node benchmark.mjs --self-test` checks
the harness's format, Unicode, resource and oracle assertions without engines.
Each fresh worker constructs the production Android factory/router and shared
`AndroidAnalysisService`, explicitly selecting its backend. Real CLI/MCP parity
is verified separately by `npm run verify:asc` and `npm run verify:android`.

## Environment and samples

Recorded on 2026-10-20, macOS 26.6.2 (25G83), arm64 Apple M4 Pro, 14 logical CPUs,
48 GiB RAM, Node 24.18.0, Python 3.14.6, OpenJDK 21.0.11. Feature source commit:
`2ba2a61a2bab7131e8d04507322d24642b7f480e`, based on REA `799e8265`. Later
documentation/measurement commits do not change the measured runtime. The
per-run entrypoint hashes identify the actual built files; they do not attest
every transitive dependency or executed byte.

The benchmark selects a **2048 MiB JADX heap**, rather than REA/JADX's
default. Both providers use a **300000 ms operation deadline**; the supervisor
also requests whole-worker cancellation after 300000 ms, covering its three
queries and close. The
**4096 MiB family RSS threshold** is a sampled cancellation guard, not a hard
OS memory cap. The harness admits APKs up to **256 MiB**; the independent oracle
and ASC use a **512 MiB expanded-DEX budget**. ASC output and captured worker JSON
are each bounded at **32 MiB**. JADX retains its own format and engine-admission
rules. These settings were checked against every recorded worker configuration.

| Sample                                                                             |       Bytes | Root DEX | Raw definitions / JADX rows | Selected class                                  |
| ---------------------------------------------------------------------------------- | ----------: | -------: | --------------------------: | ----------------------------------------------- |
| [ApiDemos 6.0.18](https://github.com/appium/android-apidemos/releases/tag/v6.0.18) |   6,521,217 |       13 |               5,700 / 2,876 | `io.appium.android.apis.ApiDemos`               |
| [Signal 8.30.3](https://github.com/signalapp/Signal-Android/releases/tag/v8.30.3)  | 114,097,843 |        6 |             40,773 / 21,861 | `org.thoughtcrime.securesms.ApplicationContext` |

SHA-256:

- ApiDemos: `a9eecf37b26cd084855c530db81c2bb1b91f4c1b095a04f47aa7c20e2791f686`.
- Signal: `9a8ddd9a2f3d7ddc6abca15eb41e5d1515f75d0bd8c45e22074767932a5dde20`.
- JADX MCP 0.7.1 JAR: `6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75`.

The public source projects declare Apache-2.0 (ApiDemos) and AGPL-3.0 (Signal);
the APKs, upstream ASC source and JAR are not committed or redistributed here.
ASC is an external Apache-2.0 dependency, not bundled implementation code.

## Task, correctness and measurement

The common task is to discover one exact, named top-level class by substring
query followed by exact selection. An independent ZIP/DEX `class_def` oracle
establishes that class exists. Every ASC matching row, raw descriptor, canonical
name, DEX entry/digest and total definition count also agrees with the oracle.
JADX's rewritten/top-level inventory is different; unequal totals are **not** a
completeness or correctness comparison of the two full inventories.

Three rounds alternate backend order. Each round uses a fresh Node/provider,
then issues one first query and two repeat queries in that Node. ASC still starts
a fresh Python process per query; JADX reuses its retained JVM. Filesystem caches
are not flushed, and the host is not exclusive. "Fresh" is not cold disk cache.
All 36 queries succeeded, all workers exited with code 0, target hashes and the
12 selected runtime/harness entrypoint hashes matched before/after, and final
sampling observed no remaining descendants.

- First-query latency includes target admission/hashing, engine initialization,
  loading, projection and Evidence. Import/construction is a separate raw phase;
  no independently isolated engine-initialization number is claimed.
- Total wall covers import/construction, three queries and close. RSS sums the
  observed Node/engine/helper family through cleanup; the oracle and external
  sampler are outside that family. Shared pages may be counted more than once.
- `ps` sampling requests 25 ms intervals, but scheduling/command cost increased
  the actual interval to about 58.4 ms at worst. RSS is a **sampled peak**, not an
  OS-enforced limit or kernel high-water mark. Short-lived processes may be missed.
- Family CPU is the cumulative time of observed processes, a lower-bound estimate,
  not exact family accounting. Worker-only CPU is separately retained in JSON.
- Output byte and sampled RSS guards fail the run rather than truncate success.
  A separate earlier 10 MiB RSS-guard run stopped all six workers and observed no
  remaining descendants; that does not establish a hard instantaneous memory cap.

## Results

Medians across three fresh runs; repeat-query medians use all six repeats.
RSS medians are of the three sampled family peaks. Milliseconds and MiB:

| Sample / backend | First query | Repeat query | Whole task | Sampled RSS |
| ---------------- | ----------: | -----------: | ---------: | ----------: |
| ApiDemos / ASC   |      3580.6 |        281.5 |     4240.1 |       265.1 |
| ApiDemos / JADX  |      4976.9 |         41.0 |     6503.1 |       840.1 |
| Signal / ASC     |      5432.4 |       2997.7 |    10471.0 |       277.8 |
| Signal / JADX    |     10714.6 |        170.1 |    12621.0 |      1919.0 |

All raw per-run metric observations, including slow runs, are retained below and
in [ApiDemos JSON](measurements/apidemos.json) and
[Signal JSON](measurements/signal.json). Complete local provider Evidence is not
committed; [its manifest](measurements/raw-evidence-manifest.json) records hashes
and sizes. A rerun produces complete Evidence alongside these measurements.

| Sample   | Round | Backend | First ms | Repeat 1 ms | Repeat 2 ms | Whole ms | RSS MiB | Observed CPU lower bound s |
| -------- | ----: | ------- | -------: | ----------: | ----------: | -------: | ------: | -------------------------: |
| ApiDemos |     1 | ASC     |   1547.8 |       282.2 |       280.7 |   2439.2 |   265.1 |                       1.74 |
| ApiDemos |     1 | JADX    |   4976.9 |        39.1 |        38.1 |   6503.1 |   848.8 |                       8.29 |
| ApiDemos |     2 | JADX    |   5642.7 |        41.4 |        40.6 |   7122.1 |   829.1 |                       8.00 |
| ApiDemos |     2 | ASC     |   4951.4 |      2785.0 |      2735.4 |  10691.5 |   268.1 |                       1.28 |
| ApiDemos |     3 | ASC     |   3580.6 |       214.4 |       184.8 |   4240.1 |   264.3 |                       1.22 |
| ApiDemos |     3 | JADX    |   4198.1 |        67.8 |        66.9 |   4765.0 |   840.1 |                      10.40 |
| Signal   |     1 | ASC     |   4525.6 |      2625.7 |      3020.5 |  10471.0 |   277.8 |                       2.68 |
| Signal   |     1 | JADX    |  10679.5 |       169.3 |       167.2 |  12471.9 |  1919.0 |                      22.17 |
| Signal   |     2 | JADX    |  11755.6 |       170.8 |       164.0 |  13438.6 |  1902.3 |                      22.48 |
| Signal   |     2 | ASC     |   5462.7 |      3382.7 |      3330.2 |  12483.3 |   280.9 |                       2.47 |
| Signal   |     3 | ASC     |   5432.4 |      2975.0 |       624.9 |   9272.1 |   277.7 |                       2.57 |
| Signal   |     3 | JADX    |  10714.6 |       214.7 |       205.3 |  12621.0 |  2016.5 |                      26.58 |

The second ApiDemos ASC whole-task run is slower than its paired JADX run.
Variance, three rounds, one large APK and the different inventory scopes limit
generalization.
No runs were selected out because they were slow. Earlier protocol failures and
an entrypoint-change-during-run failure remain in the local experiment evidence;
the final batches use the corrected protocol and reject identity drift. The
preceding `8b85ef71` timing batches are also preserved locally; the tables and
committed summaries above use every run from the refreshed `2ba2a61a` batches.

The initial REA integration exposes class discovery only. Independent engine
startup, method/source lookup, string search, reference latency and token usage
are **not compared** here. A separate large-APK bridge `string-refs` smoke returned
one `ApplicationContext` code-string occurrence; it is neither an advertised REA
operation nor an independent correctness/performance comparison with JADX.
These results do not establish Windows/Linux runtime coverage or general
decompilation, string-reference or cross-reference superiority.
