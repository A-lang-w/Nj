# Static JavaScript route inventory verification

Issue: [#4772](https://github.com/morluto/rea/issues/4772). Qualified runtime:
`7c5e2ab1765cbcfeb0514c989f17c49b6ab1219b`, tree `60737d872f01d310d09960cb3e5aec50d20e93cf`,
on main base `67a6477f011ae358fc333e5a6e26c86d932654ed`. All current corpus, public-interface and delivery measurements use that runtime.
The entire source corpus was freshly analyzed after the latest syntax-owner
change; earlier checkpoint replays remain identified in their pinned records. The JSON retains exact source digests,
commands, profiles, historical controls and material failed attempts. Earlier
qualification records are pinned to `48cc5fbc7` (runtime `b5ffdba6f`) and
`13bfba73a` (root correction `4d0630abb`); verification-only commits do not change
runtime code.

The current runtime merges main `67a6477f0`. The shared analysis-view import and
result-union conflict was resolved by retaining both route and source-to-bundle
contracts. Both view workflows are exercised below; worker resource diagnostics
from main are included in fresh analysis and delivery measurements. Dependency
and toolchain files did not change.

## Inputs, oracle, and coverage

Downloaded the 29 homepage-referenced nextjs.org scripts (1,533,098 bytes) and
38 ui.shadcn.com scripts (2,465,078 bytes), preserving original URLs, byte counts
and SHA-256. Saved bytes were independently rehashed and checked for lossless
UTF-8 decoding before writing this record. Sources were read as data.

Production isolated workers completed 64/67 source jobs, retaining route-fact
checkpoints for 65/67 sources. 3 jobs reached the unchanged 15-second deadline;
1 of those retained route facts. Unavailable sources and partial enumeration
remain visible. Each worker had a caller-selected 512 MiB old-space limit and
one semantic projection node; route syntax precedes semantic projection. The
complete probe took 200.349 s elapsed, 300.432 CPU s and
485,130,240 sampled peak family RSS bytes. No resource guard
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
115 unanchored constants; this does not establish zero application routes.

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
10.117 s elapsed, 12.912 CPU s and 2,178,109,440 sampled
peak family RSS bytes. Owned browser-group and temporary-profile cleanup succeeded.
This qualifies passive capture, not the published application's UI behavior.

## Equivalent delivery workflows

Both fresh SDK sessions used the same source, semantic budget, 512 MiB worker,
15-second deadline and `/docs` query with path, confidence, mechanisms and source
provenance. Both retained the identical parent Evidence ID
`ev_aaa74242aeb9bfd9cd1f984250a00bca9c86f135a4075b610f56183214dd8e06`,
performed three additional historical reads and exported complete Evidence.
OS caches were already warm; there was no storage-cold or statistical study.
The benchmark MCP host had a 2 GiB old-space choice; its driver had 3 GiB.
Input advertisements were explicitly `full`. New main defaults to `compact`;
that default catalog cost is not measured by this comparison.

| Measured complete workflow                                    | Complete delivery then route view | Selected view in analysis call |
| ------------------------------------------------------------- | --------------------------------: | -----------------------------: |
| Estimated tokens, used input declarations + all calls/replies |                         1,938,036 |                         58,786 |
| Estimated tokens, entire catalog + all calls/replies          |                         3,027,094 |                      1,147,844 |
| Elapsed seconds, including startup and cleanup                |                            13.854 |                         12.597 |
| CPU seconds, process family                                   |                            18.054 |                         16.516 |
| Peak sampled process-family RSS bytes                         |                     1,696,665,600 |                  1,331,994,624 |

The primary question required two calls with complete delivery and one with
selected delivery: used declarations plus primary replies estimate
1,911,096 versus 11,260 tokens. The complete analysis
reply was 6,203,541 SDK JSON bytes, versus 28,885 for the route page.
`tokenx` estimates use actual declarations, arguments and full SDK replies; they
are not actual model usage. JSON-RPC initialization/envelopes remain unmeasured.
Full-catalog costs are shown separately. SDK/Ajv validation and token-estimation
instrumentation are included in driver time, CPU and memory; their separate cost
is unmeasured. Timing varied between runs: the earlier `135c56bc2` qualification had slower
selected delivery and remains pinned at `38f2f9637`. These samples establish no
stable latency or underlying analysis-speedup claim.

Complete-mode view calls took 2071.4, 31.2, 16.0, 11.7 ms; selected-mode historical calls took
2159.4, 19.8, 12.9 ms. First calls include cold client/tool preparation that was not separately
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
  their own hierarchy. Ownership is scoped to the ordinary or typed
  interpretation: mixed siblings survive both source orders and explicit or
  inferred router roots. Rejected selected data is tracked separately so changed
  mixed configurations cannot revive stale values through another interpretation.
  Route-field initializers and member writes are owned values rather than
  independent Next constant candidates. A public exact-total regression caught
  this additional fallback path before qualification.
  Stable child-array/object aliases share the same ancestry owner as inline
  children. Both ancestry and walking consume the same cached effective fields;
  duplicate, accessor and spread overrides cannot invent a second parent.
  Ambiguous or cyclic parents stay unknown rather than shortening paths.
  Browser CLI/SDK tests require the complete nested path through aliased children.
  Changed bindings cannot revive stale roots; ordinary wrappers do not become URL
  segments. Claiming follows route-child relationships consumed by the walker,
  leaving component/loader inputs independently discoverable with uncertainty.
- Dynamic route/navigation expressions own their literal fragments. Recognized
  dynamic navigation, including variable/member destinations, records an unknown
  at the whole expression; fragments are
  not complete paths. Recognized navigation owns object and array destination
  data; callable/class definitions remain independent. Unrelated containers
  preserve bundled module constants. Relative literal destinations retain a gap
  instead of inventing a runtime base; known external URLs remain excluded.
- Based and unbased generic constants/anchors compare the same application
  segments before adding an inferred base; unrelated framework strings stay excluded. Inferred root
  `/` joins to the base itself; explicit `/app/` remains distinct. Next module
  parsing starts after `/_next/`, so deployment `app` is not a source directory.
  Known application-relative Next filenames/module paths retain their first
  segment even when its spelling matches the inferred deployment base.
- Typed trees share page classification with nested configuration. Name-only
  calls stay unknown because they can denote server endpoints. TypeScript page
  filenames retain metadata-only provenance. Raw private `_folder` trees are
  excluded before decoding, while public `%5Ffolder` spelling remains supported
  ([Next.js folder rules](https://nextjs.org/docs/app/getting-started/project-structure#private-folders)). Known capture omissions survive as
  global gaps and compact summary metadata without invented script identities.

The workflow rechecks cancellation after route-inventory finalization. A
production-boundary test delegates to the real inventory generator and injects
cancellation during its work, verifying the cancelled outcome retains completed
route Evidence. Stable/ambiguous ancestry and late-cancellation regressions failed
before the fix. Existing SDK cancellation tests also verify retained facts, prior
Evidence and subsequent request recovery.

Current execution: **208/208 source regressions** and **33/33 production-worker /
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
