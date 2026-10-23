# CLI JSON Lines verification — 2026-10-23

The analyst task was to export retained JavaScript observations as independent
records while keeping their Evidence provenance, coverage and unknowns. JSONL
framing stays in the CLI adapter; analysis and view projection continue to use
the same application workflow as MCP.

## Real artifact and completed workflow

The installed, locked `semver@7.8.5` npm package was analyzed through the public
`analyze-javascript-application` command, without executing its target code.
It parsed 50 selected files and produced a 12,185,829-byte Evidence document.
Preparation took 12.295 s elapsed, 12.648 s child CPU and 678.5 MiB sampled peak
process-family RSS; preparation is separate from the export measurements.
The artifact digest was
`65c9cce0fbebc34824c1b9657a514e7c5525ab079b232ce9da095697271b7953`.
The saved Evidence file SHA-256 was
`b34627bc12894d4c749e5b24c60731dd5a7eaaf90c98954f0e585eb442d484c3`.

The exact retained parent was reused by both variants:

```json
{
  "source": { "kind": "evidence-file", "path": "/absolute/path/parent.json" },
  "view": {
    "kind": "javascript-facts",
    "property_keys": [],
    "include_available_property_keys": true,
    "offset": 0,
    "limit": 256
  }
}
```

Each completed measurement executed one public CLI call:

```bash
node scripts/rea.mjs inspect-analysis-view request.json --format jsonl
```

The view contained 202 observation rows. Every before/after pair reconstructed
exactly equal complete Evidence JSON, including identities, subject/provider,
authority/confidence, locations, parent/view digests, links, original coverage,
17 view limitations and 20 unknowns. These source limitations remain limitations;
exhausting this selected view does not establish complete application analysis.
Before emitted one document; after emitted 202 rows and one metadata record.

## Performance

Baseline: main `169512a35bb015ff209168fb8bc1c9b31a2c678b`.
Both variants used Node 24.22.1 and the same locked dependency installation.
Three alternating pairs ran sequentially, with fresh processes and warm
filesystem/build artifacts. Node compile caching was not configured. Cold host
filesystem caches and repeated analysis were not measured.

| Completed export, median of three |    Before |     After |
| --------------------------------- | --------: | --------: |
| Elapsed time                      |   4.603 s |   4.557 s |
| Wait-accounted child CPU          |   5.914 s |   5.927 s |
| Sampled peak process-family RSS   | 496.0 MiB | 495.1 MiB |
| Emitted UTF-8 bytes               |   365,494 |   365,608 |
| `tokenx` token estimate           |    99,004 |    99,041 |
| CLI calls                         |         1 |         1 |

The small timing/memory differences do not establish an analysis speedup.
The 114-byte / 37-estimated-token increase is framing overhead, with the same
facts and no additional tool/schema round trips. These are heuristic `tokenx`
estimates, not model-specific BPE counts. Actual agent context consumption
also depends on which rows the consumer reads. No token reduction is claimed.

Rows and metadata share the existing bounded JSON encoder and awaited writes.
Token counting reuses that exact record plan, including context, and estimates
one complete line at a time rather than materializing the complete export.
A single line still must fit the estimator's runtime string limit. Token-count
performance, much larger applications and time to first consumed row were not
benchmarked.

The harness pinned the process family to two CPUs, used a 2 GiB V8 heap limit,
`GOMAXPROCS=2`, `GOMEMLIMIT=2GiB` and two libuv threads. It sampled descendant
RSS every 50 ms and would terminate the task at 6 GiB or 30 minutes. No resource
stop occurred. RSS sums can double-count shared pages and miss short peaks;
the V8 limit is per process and the sampler is not a kernel memory limit.

## Validation

Initial exact CLI tests: 150 passed across five files. Expanded validation:
236 passed across 14 CLI/MCP/acceptance files, including actual production MCP
catalogs, authenticated view reconstruction, invalid SDK option values, ordinary
and sentinel failures, generator streaming, formatter recovery, empty and partial
views, multi-megabyte/engine-limit output, pipe closure and asynchronous final
writes after cleanup success/failure. That run took 164.070 s elapsed, 194.868 s
child CPU and 1486.9 MiB sampled peak process-family RSS, without a resource stop.

The full repository `npm run check` passed after separating JSONL projection and
rendering from general format handling. After naming the transport contracts and tightening own-property admission,
`npm run check` and 28 focused JSONL/acceptance tests passed. The actual
`rea mcp doctor --format jsonl` reported healthy in one JSON line. No real
native provider behavior is claimed by these CLI tests.

Raw stdout/stderr, commands, per-run resource samples, equivalence assertions and
summaries are retained locally under
`/tmp/rea-maintenance-20261023/5629/`; they are not committed artifacts.
