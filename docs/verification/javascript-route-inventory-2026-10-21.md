# Static JavaScript route inventory verification

Issue: [#4772](https://github.com/morluto/rea/issues/4772). Qualified runtime:
`55f82eaf35fd007b7acbce2e9383fe13aa31498d`, tree `3b699d0dfcbca2abc3dace7e553ed0cd029270b8`,
on main `3dbe314ada9f6dcc994ca4655dc0faf082503847`. Current public interface, worker fixtures,
SDK and Chromium measurements use this runtime. Full-worker corpus measurements
remain pinned to `c86fc9d318f56c28e3678c2dfbdca08a20a258cb`, with current filename-owner
revalidation and exact inventory replay described below. Verification-only
commits change this report, not the runtime. Exact inputs, commands, profiles, historical
controls and meaningful failed attempts are retained in the
[verification record](javascript-route-inventory-2026-10-21.json).

## Real inputs and correctness oracle

The saved homepage references contain 29 nextjs.org scripts (1,533,098 bytes)
and 38 ui.shadcn.com scripts (2,465,078 bytes). Original URLs, byte counts and
SHA-256 are preserved. At full-worker runtime c86fc9d31, every source was freshly
rehashed and analyzed through production isolated workers with one semantic
projection node, a selected 512 MiB worker old-space limit and the existing
15-second per-source deadline. Sources were read as data; their application code
was not executed. That version's retained facts are reused only after the
current format-owner and inventory checks below.

| Supplied capture | Scripts |     Bytes | Completed jobs | Route checkpoints | Rooted patterns |
| ---------------- | ------: | --------: | -------------: | ----------------: | --------------: |
| nextjs-org       |      29 | 1,533,098 |             28 |                28 |               0 |
| shadcn-ui        |      38 | 2,465,078 |             34 |                35 |              18 |

At c86fc9d31, the complete 67-worker task took **283.792 s elapsed**,
**421.694 CPU s** and **495,742,976 bytes** sampled
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
cleanup succeeded. This task took **11.997 s elapsed**,
**14.942 CPU s** and **2,175,156,224 bytes** sampled
peak family RSS. This does not qualify the published application's live UI.

At the current runtime, all 67 original sources were rehashed and parsed. The
new/old filename owners were compared on every literal/template value (a superset
of scanner inputs) and four URL/path metadata variants per file. Positive controls
verify the new unknown branch and private exclusion. No captured input enters
the new interception branch, and every known classification is identical. The
current inventory owner then exactly reproduces both complete retained inventories.
This check took **2.120 s elapsed**,
**2.677 CPU s** and
**296,652,800 bytes** sampled
peak family RSS. It requalifies retained route facts for this narrow format change;
no new full 67-worker run or current underlying-analysis speedup is claimed.
Public fixtures, SDK and Chromium below are freshly executed on the current runtime.

The earlier 658 narrow old-owner/current-owner deadline comparison remains pinned
to that historical runtime in JSON; it does not qualify this newer scanner.
Captures and narrow controls establish no general performance equivalence or
code-specific cause for timing/deadline variation.

## Equivalent delivery workflows

Both fresh SDK sessions used the same selected production chunk, analysis
budgets and `/docs` query, returning paths, confidence, mechanisms and provenance.
Explicit source selection retains the 38-file inventory while analyzing only the
selected file; other sources remain unknown. Both sessions retained the same
complete parent Evidence `ev_aaa74242aeb9bfd9cd1f984250a00bca9c86f135a4075b610f56183214dd8e06`,
performed three historical view reads and exported complete Evidence.

| Completed workflow                                              | Complete analysis, then route view | Route view in analysis call |
| --------------------------------------------------------------- | ---------------------------------: | --------------------------: |
| Estimated tokens: used input declarations and all calls/replies |                          1,938,095 |                      58,845 |
| Estimated tokens: entire catalog and all calls/replies          |                          3,029,568 |                   1,150,318 |
| Elapsed seconds, including startup and cleanup                  |                             18.023 |                      16.686 |
| CPU seconds, process family                                     |                             23.560 |                      21.530 |
| Peak sampled process-family RSS bytes                           |                      1,757,306,880 |               1,333,936,128 |

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
callable/component bodies keep their own context. One Next filename classifier
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

**491/491 source/owner regressions** and **70/70 compiled
worker/public CLI/SDK/schema tests** passed on the qualified runtime, including
current-main CDP observation-window boundaries. Typecheck/lint passed through
`npm run check:fast`; final documentation validation is recorded separately.
The public suite exercises exported-Evidence reads after source deletion,
large bounded facts, source selection, retention, cancellation, SDK recovery,
source-to-bundle integration and every advertised tool schema.

Four intercepted-page regressions failed before the current correction; two
private-folder precedence controls and existing ordinary/parallel/group path cases
pass. Earlier six ancestry/typed-child failures and two navigation-data failures,
plus the callable-body compatibility control, remain recorded. Earlier delivery,
wrapped-navigation, corrected-oracle and failed-control records remain pinned
to their actual runtimes. Earlier capacity, cleanup, malformed
input, cancellation and matched main/runtime deadline controls remain pinned
to their actual revisions. Historical conditional corpus replays are not used
as the current full-worker qualification. Earlier technical CI results do not
qualify this head; latest CI/review must be checked separately.

No claim is made for complete application routes, live route execution, private
issue samples, external cloud clients or Windows/macOS provider execution.
