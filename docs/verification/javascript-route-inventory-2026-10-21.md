# Static JavaScript route inventory verification

Issue: [#4772](https://github.com/morluto/rea/issues/4772). Qualified runtime:
`6363f40a106b472db39280918f5bfd48088134be`, tree `3a7613938e61b5d5626b2bc88950061945fa459f`,
on main `3dbe314ada9f6dcc994ca4655dc0faf082503847`. Current public interface, worker fixtures,
SDK, Chromium and the complete fresh 67-worker corpus measurements use this
runtime. Verification-only
commits change this report, not the runtime. Exact inputs, commands, profiles, historical
controls and meaningful failed attempts are retained in the
[verification record](javascript-route-inventory-2026-10-21.json).

## Real inputs and correctness oracle

The saved homepage references contain 29 nextjs.org scripts (1,533,098 bytes)
and 38 ui.shadcn.com scripts (2,465,078 bytes). Original URLs, byte counts and
SHA-256 are preserved. At the current qualified runtime, every source was freshly
rehashed and analyzed through production isolated workers with one semantic
projection node, a selected 512 MiB worker old-space limit and the existing
15-second per-source deadline. Sources were read as data; their application code
was not executed. Every worker analysis is fresh; no retained source facts or
conditional classifier replay are used for this qualification.

| Supplied capture | Scripts |     Bytes | Completed jobs | Route checkpoints | Rooted patterns |
| ---------------- | ------: | --------: | -------------: | ----------------: | --------------: |
| nextjs-org       |      29 | 1,533,098 |             28 |                28 |               0 |
| shadcn-ui        |      38 | 2,465,078 |             36 |                37 |              18 |

At the current runtime, the complete 67-worker task took **201.783 s elapsed**,
**301.510 CPU s** and **514,576,384 bytes** sampled
peak process-family RSS. Unavailable jobs, configured deadlines and partial
facts remain explicit in the record. Zero supported rooted Next patterns does
not establish zero application routes. Lazy/server-only code, reachability and
the application route denominator remain unknown.

Independent direct-byte inspection of the
[86,218-byte production chunk](https://ui.shadcn.com/_next/static/immutable/chunks/0ftd4gqztonqp.js)
finds exactly 18 unescaped quoted `/docs` literals, including 12 direct `href`
properties. SHA-256:
`45c6ead1e08cc578464e7a0c6b2e6764d7af83f99039e291f288a971b988b3fc`.
Every fresh SDK and browser verifier requires the entire sorted 18-pattern oracle,
alongside source identity, provenance and retained Evidence. These are static
candidates, not served-page claims.

A real owned Chromium 156.0.8078.4 process compiled the
production chunk with `Runtime.compileScript`/`persistScript` in a blank local
page, without running it. Public CLI and official SDK `analyze_web_bundle` calls
passively captured that inert source via CDP and returned all 18 patterns, its
original URL and exact SHA-256. Source parsing was complete, enumeration partial
and application coverage unknown. Owned browser-group and temporary-profile
cleanup succeeded. This task took **12.057 s elapsed**,
**15.526 CPU s** and **2,184,130,560 bytes** sampled
peak family RSS. This does not qualify the published application's live UI.

The earlier c86 worker corpus, 55 filename-classifier replay and 658 narrow
old-owner/current-owner deadline comparison remain pinned to their historical
runtimes in JSON. They do not qualify this newer scanner. Captures and narrow
controls establish no general performance equivalence or code-specific cause
for timing/deadline variation. Current public fixtures, SDK, Chromium and all
67 source workers below are freshly executed.

## Equivalent delivery workflows

Both fresh SDK sessions used the same selected production chunk, analysis
budgets and `/docs` query, returning paths, confidence, mechanisms and provenance.
Explicit source selection retains the 38-file inventory while analyzing only the
selected file; other sources remain unknown. Both sessions retained the same
complete parent Evidence `ev_8ed574a3a7a6fa16333857e921c69789dde59f7c61c5691225d1b3eaa114218d`,
performed three historical view reads and exported complete Evidence.

| Completed workflow                                              | Complete analysis, then route view | Route view in analysis call |
| --------------------------------------------------------------- | ---------------------------------: | --------------------------: |
| Estimated tokens: used input declarations and all calls/replies |                          1,938,137 |                      58,845 |
| Estimated tokens: entire catalog and all calls/replies          |                          3,029,610 |                   1,150,318 |
| Elapsed seconds, including startup and cleanup                  |                             14.267 |                      12.710 |
| CPU seconds, process family                                     |                             18.615 |                      16.632 |
| Peak sampled process-family RSS bytes                           |                      1,611,264,000 |               1,313,144,832 |

Token counts are tokenx estimates of actual SDK advertisements, arguments and
complete replies, including follow-up reads and export. JSON-RPC envelopes,
initialization and actual model usage are unmeasured. Advertisements were
explicitly full; main's compact-default catalog cost is not measured by this
comparison. SDK/Ajv/token instrumentation is included in elapsed/CPU/RSS; its
separate cost is unmeasured. OS caches were warm, with fresh sessions/workers.
There is no storage-cold or statistical study and no stable latency or underlying
analysis-speedup claim. The earlier slower selected run remains in historical
records. All profiles sample descendant-task RSS every 20 ms, use CPU affinity
0,1, and have an 8 GiB/420 s guard; no successful qualifier hit either guard.

## Shared contracts, ownership and bounds

The existing syntax walk and binding/mutation index own route facts. The shared
inventory and retained analysis-view service serve both CLI and MCP. Exact
pattern/source/occurrence/gap identities, ranges, parent Evidence, provenance,
coverage and limitations survive filtering, field selection, paging and batch
reads. Empty ID filters select nothing. Missing historical inventories are
unmeasured rather than empty. Complete Evidence stays accessible; CLI selected
views require its export and MCP verifies retention before analysis.

Configuration ownership and ancestry consume the same cached effective fields.
Erased TypeScript wrappers use the shared AST normalization owner. Named-parent
`addRoute(name, record)` configurations start with unknown parent ancestry.
Relative paths stay unresolved until an absolute literal resets the root, including
below dynamic/uncertain parents. Inline, stable aliased and wrapped records are
covered. Selected typed children always reach the walker; unsupported expressions
retain interpretation gaps and rejected argument objects cannot revive as roots.
The overload semantics are checked against the
[Vue Router guide](https://router.vuejs.org/guide/advanced/dynamic-routing.html#adding-nested-routes).
Dynamic/ambiguous/mutated/cyclic parents and incomplete capture remain gaps.
Recognized local navigation objects expose literal pathnames while owning their
query/search/hash data. Ownership is checked before discovering automatic roots
or ancestry edges, preventing query objects from becoming pages. Independent
callable/component bodies keep their own context. A mandatory preparation factory
now resolves recognized stable destination aliases against the shared mutation
index before any fact admission. Its bounded value-ownership closure excludes
query/module data without following callee or projected namespaces wholesale.
Repeated alias uses keep distinct use-site occurrence identities and initializer
segment ranges. Mutation, cycle and unresolved projection uncertainty remain
gaps; opaque escape does not make a value stable. Both application and browser
consumers use the same factory. One Next filename classifier
returns known paths, unknown interception context or non-pages. Both AST scanning
and metadata inventory retain interception gaps with precise or null ranges,
respectively. Private folders exclude the entire page before interception and
decoding; percent-encoded public underscores stay supported. Full/compact SDK
queries retain a real TSX file's gap, partial coverage and exact SHA after deleting
its source. See the [Next interception convention](https://nextjs.org/docs/app/api-reference/file-conventions/intercepting-routes).

Canonical discriminated delivery contracts share the domain shapes used by CLI.
Optional complete input is dispatched before its default, preserving omission
compatibility and SDK field diagnostics. Full wire schemas derive discriminator
conditionals from those alternatives, preserving object roots and avoiding root
unions or duplicated view schemas. Ajv validates both 2020-12 and draft-07
projections and their valid/invalid combinations. Production SDK full/compact
profiles verify strict server rejection and subsequent recovery. External cloud
client execution is unverified.

Source-work/fact and inventory budgets are 8 MiB; optional facts fit the actual
remaining combined-result budget. Pages are bounded at 1 MiB including the
81-byte digest sealing field; exact-limit summaries are accepted and over-limit
single rows remain typed capacity errors. Known source omissions retain coverage
and gap facts. Immutable normalized-parent snapshots use weak identity caching;
subject identity is rechecked before reuse, with no live-target-state cache.
Cancellation preserves completed facts and earlier Evidence, including during
inventory finalization, and owned worker cleanup/retry remains covered.

## Executed checks and limits

**521/521 source/owner regressions** and **70/70 compiled
worker/public CLI/SDK/schema tests** passed on the qualified runtime, including
current-main CDP observation-window boundaries. Typecheck/lint passed through
`npm run check:fast`; final documentation validation is recorded separately.
The public suite exercises exported-Evidence reads after source deletion,
large bounded facts, source selection, retention, cancellation, SDK recovery,
source-to-bundle integration and every advertised tool schema.

Seven condition-only/reference-edge regressions failed before this correction
(7/110), while six actual-data-branch controls already passed. One owner now
classifies which syntax edges supply navigation data. Conditional tests, unary
and comparison/numeric operations, && guards, nonfinal sequence operands and
computed keys do not claim independent lexical initializers. Actual conditional
branches, returned ||/?? operands and final sequence expressions still do.
Full/compact SDK historical views preserve a condition-only independent route
after source deletion; both browser adapters preserve a boolean-only reference.
The earlier callee/projection exclusions share the same edge classifier.

The prior seven aliased-navigation failures, passing binary-example/cycle
controls, per-use identity, initializer provenance, callable independence,
mutation/shadowing and long-chain budget checks remain covered. One earlier
suite assertion wrongly expected stability after opaque escape; its corrected
before-escape positive and after-escape unknown controls preserve the existing
freshness guard. Earlier intercepted-page, ancestry, typed-child, delivery,
capacity, cleanup, cancellation and failed-control records remain pinned to
their actual revisions. Earlier technical CI results do not qualify this head;
latest CI/review must be checked separately.

No claim is made for complete application routes, live route execution, private
issue samples, external cloud clients or Windows/macOS provider execution.
