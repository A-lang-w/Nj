# Static JavaScript route inventory verification

Issue: [#4772](https://github.com/morluto/rea/issues/4772). Qualified runtime:
`658a5bd1ed4c3d414567335f44568b2c2a9276cf`, tree `fe2e0be3cd1023dbb6a04f45670ab018b779ec14`,
on main `3dbe314ada9f6dcc994ca4655dc0faf082503847`. All current source-worker, public interface,
SDK and Chromium measurements below use this runtime. Verification-only commits
change this report, not the runtime. Exact inputs, commands, profiles, historical
controls and meaningful failed attempts are retained in the
[verification record](javascript-route-inventory-2026-10-21.json).

## Real inputs and correctness oracle

The saved homepage references contain 29 nextjs.org scripts (1,533,098 bytes)
and 38 ui.shadcn.com scripts (2,465,078 bytes). Original URLs, byte counts and
SHA-256 are preserved. Each source was freshly rehashed and analyzed through
production isolated workers, with one semantic projection node, a selected
512 MiB worker old-space limit and the existing 15-second per-source deadline.
No previous source facts were reused for this qualification. Sources were read
as data; their application code was not executed.

| Supplied capture | Scripts |     Bytes | Completed jobs | Route checkpoints | Rooted patterns |
| ---------------- | ------: | --------: | -------------: | ----------------: | --------------: |
| nextjs-org       |      29 | 1,533,098 |             28 |                28 |               0 |
| shadcn-ui        |      38 | 2,465,078 |             36 |                36 |              18 |

The complete 67-worker task took **291.983 s elapsed**,
**417.351 CPU s** and **479,731,712 bytes** sampled
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
cleanup succeeded. This task took **22.076 s elapsed**,
**27.164 CPU s** and **2,186,874,880 bytes** sampled
peak family RSS. This does not qualify the published application's live UI.

The fresh corpus contains one additional deadline compared with the earlier
56dda3b9f corpus record. Its controlled old-owner/current-owner pair uses the
same new-main runtime and inputs, replacing only the route scanner, and retains
both outcomes and the complete dist-byte comparison in JSON. This is a narrow
control, not a baseline-main or statistical performance qualification. The
complete current corpus is slower than the historical run; no code-specific
cause or analysis-speed advantage is established.

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
| Elapsed seconds, including startup and cleanup                  |                             30.254 |                      27.922 |
| CPU seconds, process family                                     |                             38.319 |                      34.270 |
| Peak sampled process-family RSS bytes                           |                      1,450,442,752 |               1,258,061,824 |

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
`addRoute(name, record)` configurations retain unknown parent ancestry instead
of inventing root paths; inline, stable aliased and wrapped records are covered.
The overload semantics are checked against the
[Vue Router guide](https://router.vuejs.org/guide/advanced/dynamic-routing.html#adding-nested-routes).
Dynamic/ambiguous/mutated/cyclic parents and incomplete capture remain gaps.
Recognized local navigation objects expose literal pathnames while owning their
query/search/hash data. Independent component bodies keep their own context.

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

**475/475 source/owner regressions** and **70/70 compiled
worker/public CLI/SDK/schema tests** passed on the qualified runtime, including
current-main CDP observation-window boundaries. Typecheck/lint passed through
`npm run check:fast`; final documentation validation is recorded separately.
The public suite exercises exported-Evidence reads after source deletion,
large bounded facts, source selection, retention, cancellation, SDK recovery,
source-to-bundle integration and every advertised tool schema.

The record preserves five meaningful named-parent/wrapped-object cases failing
before the fix, the plain-union SDK diagnostic regression and its structural
correction, and corrected scalar-wrapper and worker oracles. Earlier capacity, cleanup, malformed
input, cancellation and matched main/runtime deadline controls remain pinned
to their actual revisions. Historical conditional corpus replays are not used
as the current full-worker qualification. Earlier technical CI results do not
qualify this head; latest CI/review must be checked separately.

No claim is made for complete application routes, live route execution, private
issue samples, external cloud clients or Windows/macOS provider execution.
