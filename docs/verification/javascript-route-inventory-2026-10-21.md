# Static JavaScript route inventory verification

Issue: [#4772](https://github.com/morluto/rea/issues/4772). Qualified runtime:
`b5ffdba6ffdccb7639db12830ec25aa9a697f3f4`, tree
`7734257d78540ddef3da300a38858f3a4561b712`, on main base `6d356b843`.
The accompanying JSON retains source digests, matched workflow measurements,
review corrections, deadline controls and failed attempts. Verification-only
commits do not change runtime code. Initial qualification of runtime `6c7a72505`
is retained at record commit `af138bc4e`; the results below use the corrected runtime
unless a different revision is stated.

## Inputs, oracle, and coverage

Downloaded the 29 script URLs referenced by the nextjs.org homepage
(1,533,098 bytes) and 38 referenced by ui.shadcn.com (2,465,078 bytes), preserving
original URLs, byte counts and SHA-256. Saved bytes were independently rehashed
and checked for lossless UTF-8 decoding before this record was written. Sources
were read as data.

Production isolated workers completed 63 of 67 source analyses with a 512 MiB
old-space choice and 15-second per-source deadline. Four reached the deadline;
two of those retained static route checkpoints, giving 65 route-fact sources.
Unavailable sources remain visible, and application route coverage remains
unknown. The complete probe took 292.991 s elapsed, 385.580 CPU s and 466,817,024
sampled peak family RSS bytes. No family memory guard stopped it. The semantic
projection budget was explicitly one node; syntax collection precedes semantic
projection, and this choice is not silently imposed by the feature.

The shadcn corpus yields 18 `/docs` patterns and 31 detector/site occurrences.
Independent direct-byte inspection of its
[86,218-byte production chunk](https://ui.shadcn.com/_next/static/immutable/chunks/0ftd4gqztonqp.js)
finds exactly those 18 unescaped quoted `/docs` literals, including 12 direct
`href` properties. SHA-256:
`45c6ead1e08cc578464e7a0c6b2e6764d7af83f99039e291f288a971b988b3fc`.
This checks declared static candidates, not served pages. The nextjs.org capture
yields zero supported rooted candidates and excludes 128 unanchored constants;
it does not establish zero application routes. Lazy and server-only code,
reachability and the application's complete route denominator remain unknown.

Actual public CLI and official SDK calls returned the same 18 patterns from this
source. Caller-selected `source_paths` retained the 38-file inventory while only
analyzing the selected chunk; other sources stayed unknown. SDK-converted
input/output schemas and actual requests/replies passed Ajv 2020-12 validation.

A real Chromium 156.0.8078.4 process, owned by REA's existing verifier lifecycle,
compiled the production chunk with `Runtime.compileScript` and `persistScript`
in a blank local page. The chunk was never run. CLI and SDK `analyze_web_bundle`
calls captured this inert source through CDP and returned the same 18 patterns,
original URL and SHA-256. Selected-source parsing and enumeration were complete;
application coverage remained unknown. The verifier took 14.604 s elapsed,
17.008 CPU s and 2,137,911,296 sampled peak family RSS bytes. Owned browser group
and temporary profile cleanup succeeded. This qualifies passive provider capture,
not the published application's UI behavior.

## Equivalent delivery workflows

Both fresh SDK sessions used the same source, semantic budget, 512 MiB worker,
15-second deadline and `/docs` query with path, confidence, mechanisms and source
provenance. Both retained parent Evidence ID
`ev_bfcb4e0a8eea576f4ca5b501b633d265f65d15ef9c9b234250e90c822a0d759d`,
performed three additional historical reads, and exported complete Evidence.
OS caches were already warm; there was no storage-cold or statistical study.

| Measured complete workflow                                    | Complete delivery then route view | Selected view in analysis call |
| ------------------------------------------------------------- | --------------------------------: | -----------------------------: |
| Estimated tokens, used input declarations + all calls/replies |                         1,934,657 |                         58,252 |
| Estimated tokens, entire catalog + all calls/replies          |                         3,017,231 |                      1,140,826 |
| Elapsed seconds, including startup and cleanup                |                            19.083 |                         18.499 |
| CPU seconds, process family                                   |                            23.893 |                         22.593 |
| Peak sampled process-family RSS bytes                         |                     1,541,779,456 |                  1,386,733,568 |

The primary question required two calls with complete delivery and one with
selected delivery. Used declarations plus primary replies estimate 1,907,717
versus 11,260 tokens. The complete analysis reply was 6,194,453 SDK JSON bytes;
the route page was 28,885 bytes. `tokenx` estimates use actual advertised
declarations, arguments and full SDK replies; they are not actual model usage.
JSON-RPC initialization/envelopes remain unmeasured. Full-catalog costs are shown
separately. SDK/Ajv validation and token-estimation instrumentation are included
in driver elapsed time, CPU and memory; their separate cost is unmeasured.
These timings do not establish an underlying source-analysis speedup.

Complete-mode follow-up reads took 38.4, 26.6 and 11.3 ms. Selected-mode reads
took 3836.4, 47.5 and 33.4 ms; the first includes cold client/tool preparation,
which was not separately profiled. The immutable-snapshot cache does not establish
zero preparation cost. Projection preserves complete Evidence materialization.

Family RSS sums live descendants discovered through every task's child list at
20 ms intervals. It excludes the observer and can miss shorter peaks. CPU uses
waited family usage with inherited shell usage removed. Profiles retain payload
status and an 8 GiB family / 420-second stop guard; no qualifying run hit it.

## Review regressions and executed checks

The result owner now fits optional route facts into the bytes remaining after
legacy facts in both worker serialization boundaries. A real 12,000-registration,
1,452,889-byte source previously lost its entire checkpoint at runtime `6c7a72505`.
At corrective runtime `e38943545`, all 12,000 legacy endpoints and a 10,413-candidate
prefix survived in 8,388,147 serialized bytes, below the unchanged 8 MiB limit.
The facet reports result capacity and retains the preceding work-capacity reason.
That worker run took 5.671 s elapsed, 8.649 CPU s and 497,098,752 peak family RSS
bytes. An actual SDK regression also passed on the qualified runtime: compact
rows, source SHA, partial enumeration, capacity provenance and retained gap lookup.

Configuration ownership is separate from validity and actual `children` path
ancestry. Reassigned/mutated configurations do not revive stale inferred roots;
ordinary wrapper keys do not create URL ancestors. Rooted constants are checked
before an inferred base is added. Typed trees share page classification with
nested router configuration; name-only calls remain unknown because the same
syntax can describe server endpoints. Next App Router metadata recognizes
`page.ts` and `page.tsx`. Known capture omissions survive as queryable global gaps
and compact summary metadata without invented script identities or ranges.

- Corrected runtime source regressions: **178/178** across scanner, inventory,
  fitter, retained views, web analyzer, worker schemas, Evidence service and legacy
  route-property tests.
- Public CLI/SDK acceptance: **5/5**, including exported Evidence after source
  deletion, captured routes, actual converted schemas and the large-source case.
- Corrective runtime `e38943545` public/production-worker set: **20/20**. Earlier
  matching main/initial-runtime real-worker/browser-MCP/retention sets: **23/23**
  each; isolated browser/legacy control: **6/6**. One initial aggregate browser
  timeout was not reproduced, without changing its deadline; cause unproven.
- `npm run check:fast` and `npm run docs:check`: **passed**.

Fresh deadline controls compared the same 229,185-byte chunk on main and initial
runtime `6c7a72505`, and the same 155,988-byte chunk on main and corrective runtime
`e38943545`. Both pairs timed out under the same 512 MiB / 15-second choices.
Checkpoint phase varied between runs. The planned serialization-counter comparison
could not run without a checkpoint, so its cost remains unmeasured. No
code-specific timeout cause or baseline-wide explanation is claimed.

The JSON preserves material failed attempts: an unisolated probe exhausted its
configured V8 heap; an invalid harness supplied URL module paths and overlapped
build cleanup with workers; early export tests used an unsupported option and
supplied a bundle where one Evidence record was required; a benchmark had a
syntax error before any request. Only corrected production-boundary runs qualify
this feature. No live published-page, Windows/macOS, private issue sample,
reachability or complete application route-count claim is made.
