# Static JavaScript route inventory verification

Issue: [#4772](https://github.com/morluto/rea/issues/4772). Qualified runtime:
`8e59effd5d9ddd9e8a95b0bfda1eec8752fce25f`, tree `ad1fed1422fda685fccf0461d0c1db1b79b5bd4e`,
on main base `6d356b843`. All current corpus, public-interface and delivery measurements use that runtime.
The entire source corpus was freshly analyzed after the latest syntax-owner
change; earlier checkpoint replays remain identified in their pinned records. The JSON retains exact source digests,
commands, profiles, historical controls and material failed attempts. Earlier
qualification records are pinned to `48cc5fbc7` (runtime `b5ffdba6f`) and
`13bfba73a` (root correction `4d0630abb`); verification-only commits do not change
runtime code.

## Inputs, oracle, and coverage

Downloaded the 29 homepage-referenced nextjs.org scripts (1,533,098 bytes) and
38 ui.shadcn.com scripts (2,465,078 bytes), preserving original URLs, byte counts
and SHA-256. Saved bytes were independently rehashed and checked for lossless
UTF-8 decoding before writing this record. Sources were read as data.

Production isolated workers completed 65/67 source jobs, retaining route-fact
checkpoints for 65/67 sources. 2 jobs reached the unchanged 15-second deadline;
0 of those retained route facts. Unavailable sources and partial enumeration
remain visible. Each worker had a caller-selected 512 MiB old-space limit and
one semantic projection node; route syntax precedes semantic projection. The
complete probe took 198.365 s elapsed, 297.875 CPU s and
500,359,168 sampled peak family RSS bytes. No resource guard
stopped it. These captures do not establish lazy/server-only code, reachability
or a complete application route denominator.

The shadcn corpus yields 18 `/docs` patterns and
31 detector/site occurrences. Independent direct-byte inspection of its
[86,218-byte production chunk](https://ui.shadcn.com/_next/static/immutable/chunks/0ftd4gqztonqp.js)
finds exactly those 18 unescaped quoted `/docs` literals, including 12 direct
`href` properties. SHA-256:
`45c6ead1e08cc578464e7a0c6b2e6764d7af83f99039e291f288a971b988b3fc`.
They support static candidates, not served-page claims. Next's homepage capture
yields zero supported rooted candidates and excludes
126 unanchored constants; this does not establish zero application routes.

Public CLI and official SDK calls return the same 18 patterns from that source.
Explicit `source_paths` retains the 38-file inventory while analyzing only the
selected chunk; other sources stay unknown. Actual SDK-converted input/output
schemas and requests/replies passed Ajv 2020-12 validation. Qualification now
requires the complete immutable 18-pattern oracle in each driver, alongside
source identity and retained Evidence checks.

A real owned Chromium 156.0.8078.4 process compiled the production chunk using
`Runtime.compileScript` and `persistScript` in a blank local page, without running
it. Actual CLI and SDK `analyze_web_bundle` calls captured that inert source via
CDP and returned all 18 patterns, its original URL and exact SHA-256.
Selected-source parsing was `complete` and candidate enumeration
`partial`; application coverage stayed unknown. The verifier took
9.683 s elapsed, 12.204 CPU s and 2,157,563,904 sampled
peak family RSS bytes. Owned browser-group and temporary-profile cleanup succeeded.
This qualifies passive capture, not the published application's UI behavior.

## Equivalent delivery workflows

Both fresh SDK sessions used the same source, semantic budget, 512 MiB worker,
15-second deadline and `/docs` query with path, confidence, mechanisms and source
provenance. Both retained the identical parent Evidence ID
`ev_345bf4f2dff7e6a89b26a896d07c4a1ff5a8fd22d092c7ead2cba04d4b021509`,
performed three additional historical reads and exported complete Evidence.
OS caches were already warm; there was no storage-cold or statistical study.
The benchmark MCP host had a 2 GiB old-space choice; its driver had 3 GiB.
Input advertisements were explicitly `full`. New main defaults to `compact`;
that default catalog cost is not measured by this comparison.

| Measured complete workflow                                    | Complete delivery then route view | Selected view in analysis call |
| ------------------------------------------------------------- | --------------------------------: | -----------------------------: |
| Estimated tokens, used input declarations + all calls/replies |                         1,937,112 |                         58,252 |
| Estimated tokens, entire catalog + all calls/replies          |                         3,019,686 |                      1,140,826 |
| Elapsed seconds, including startup and cleanup                |                            14.292 |                         12.496 |
| CPU seconds, process family                                   |                            18.831 |                         16.494 |
| Peak sampled process-family RSS bytes                         |                     1,567,694,848 |                  1,278,681,088 |

The primary question required two calls with complete delivery and one with
selected delivery: used declarations plus primary replies estimate
1,910,172 versus 11,260 tokens. The complete analysis
reply was 6,202,233 SDK JSON bytes, versus 28,885 for the route page.
`tokenx` estimates use actual declarations, arguments and full SDK replies; they
are not actual model usage. JSON-RPC initialization/envelopes remain unmeasured.
Full-catalog costs are shown separately. SDK/Ajv validation and token-estimation
instrumentation are included in driver time, CPU and memory; their separate cost
is unmeasured. Timing varied between runs: the earlier `135c56bc2` qualification had slower
selected delivery and remains pinned at `38f2f9637`. These samples establish no
stable latency or underlying analysis-speedup claim.

Complete-mode view calls took 2042.7, 31.9, 16.5, 11.7 ms; selected-mode historical calls took
2023.4, 20.7, 13.1 ms. First calls include cold client/tool preparation that was not separately
profiled. The immutable-snapshot cache does not establish zero preparation cost.
Projection preserves complete Evidence materialization.

Family RSS sums live descendants discovered through every task's child list at
20 ms intervals, excluding the observer; shorter peaks may be missed. CPU uses
waited family usage with inherited shell usage removed. Profiles retain payload
status and an 8 GiB family / 420-second stop guard; no qualifying run hit it.

## Review regressions and executed checks

- Optional route facts fit the actual bytes remaining after legacy findings at
  both worker serialization owners. A real 12,000-registration, 1,452,889-byte
  source lost its checkpoint at initial runtime `6c7a72505`. Corrective runtime
  `e38943545` retained all 12,000 legacy endpoints plus 10,413 route candidates in
  8,388,147 bytes, below the unchanged 8 MiB ceiling. It took 5.671 s elapsed,
  8.649 CPU s and 497,098,752 peak family RSS bytes. The latest production worker
  and SDK tests recheck bounded retention, SHA, partial coverage and gap lookup.
- Configuration ownership is independent of validity and actual child ancestry.
  Ordinary pathless layout groups retain their parents, while typed trees keep
  their own hierarchy. Browser CLI/SDK tests require the complete nested path.
  Changed bindings cannot revive stale roots; ordinary wrappers do not become URL
  segments. Claiming follows route-child relationships consumed by the walker,
  leaving component/loader inputs independently discoverable with uncertainty.
- Dynamic route/navigation expressions own their literal fragments. Recognized
  dynamic navigation, including variable/member destinations, records an unknown
  at the whole expression; fragments are
  not complete paths. Ownership stops at arrays, objects and callable/class
  definitions, preserving independent constants inside bundled module bodies.
- Based and unbased generic constants/anchors compare the same application
  segments before adding an inferred base; unrelated framework strings stay excluded. Inferred root
  `/` joins to the base itself; explicit `/app/` remains distinct. Next module
  parsing starts after `/_next/`, so deployment `app` is not a source directory. Filename/module-derived paths
  remain application-relative during anchoring and deployment-prefix joining;
  ordinary destination literals may already include their deployment base.
- Typed trees share page classification with nested configuration. Name-only
  calls stay unknown because they can denote server endpoints. TypeScript page
  filenames retain metadata-only provenance. Raw private `_folder` trees are
  excluded before decoding, while public `%5Ffolder` spelling remains supported
  ([Next.js folder rules](https://nextjs.org/docs/app/getting-started/project-structure#private-folders)). Known capture omissions survive as
  global gaps and compact summary metadata without invented script identities.

Current execution: **199/199 source regressions** and **28/28 production-worker /
public CLI/SDK tests** passed, including source deletion before exported-Evidence
queries, Turbopack-shaped modules, dynamic prefixes and independent component
route tables. Exact advertised-input tests explicitly select the full profile;
SDK tests cover both full and compact advertisements, canonical rejection of
invalid selectors and recovery. This fixes the CI integration with main #5975
without weakening canonical validation. `npm run check:fast` and `npm run docs:check` passed. Earlier matched
main/initial-runtime real-worker/browser-MCP/retention controls passed **23/23**
each; isolated browser/legacy controls passed **6/6**. An initial aggregate browser
timeout was not reproduced without changing its deadline; its cause is unproven.

Fresh historical deadline controls compared the same 229,185-byte chunk on main
and runtime `6c7a72505`, and the same 155,988-byte chunk on main and runtime
`e38943545`. Both pairs timed out under matching 512 MiB / 15-second choices.
Checkpoint phases varied. The planned serialization-counter comparison could
not run without a checkpoint, so that cost remains unmeasured. No code-specific
timeout cause or baseline-wide explanation is claimed.

The JSON preserves failed attempts: an unisolated probe exhausted its configured
heap; a harness used URL module paths and overlapped build cleanup with workers;
early export tests used the wrong option and a bundle where one Evidence record
was required; a benchmark failed syntax checking before any request; a browser
verifier correctly refused an existing output path. Runtime `9437a1215` also
failed semantic qualification: it returned only 12 patterns because ownership
crossed a module boundary. Agreement/subset checks alone missed the loss; the
current unit/public regressions and full-oracle drivers detect it. That run is
not reported as passing qualification. No live published-page, Windows/macOS,
private issue sample, reachability or complete application route-count claim is made.
