# Static JavaScript route inventory verification

Issue: [#4772](https://github.com/morluto/rea/issues/4772). Qualified runtime:
`723bb3336f029a265d884c59d240fcf229589ba0`, tree `9125dceabfdd496e1bb0ea460778f9bbe0989040`,
on main `183b4d4e7e303561cb06617fa485d996a4c99f63`. Current public interface, worker fixtures,
SDK, Chromium and the complete fresh 67-worker corpus measurements use this
runtime. Verification-only
commits change this report, not the runtime. Exact inputs, commands, profiles, historical
controls and meaningful failed attempts are retained in the
[verification record](javascript-route-inventory-2026-10-21.json).

Current qualification was recorded at `2026-10-22T02:56:01.399Z`.
The source capture and initial report date remain pinned to the original inputs.
The main integration includes the independently verified [CI fixture fix #6186](https://github.com/morluto/rea/pull/6186).
Route facts, inventory and views now use the same JavaScript coordinate owner as
application and semantic graphs; the duplicate range schema and alias are removed.
Accepted ranges retain one-based lines, zero-based UTF-16 columns and exclusive ends.
Shared input registration and host-absolute path contracts remain in effect.
The main183 integration uses the canonical web-bundle state owner for included
scripts, accumulator types and construction; old inspection definitions/factory
are removed. The current compiled boundary verifies that the isolated coordinator
loads without loading the worker's JavaScript parser.

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
| shadcn-ui        |      38 | 2,465,078 |             35 |                36 |              18 |

At the current runtime, the complete 67-worker task took **316.205 s elapsed**,
**383.395 CPU s** and **483,258,368 bytes** sampled
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
cleanup succeeded. This task took **12.337 s elapsed**,
**14.147 CPU s** and **2,172,530,688 bytes** sampled
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
complete parent Evidence `ev_2fd5505290ac32a27a696198bbb8bbdc794c14cc26d2b968f4f70ee3c147609c`,
performed three historical view reads and exported complete Evidence.

| Completed workflow                                              | Complete analysis, then route view | Route view in analysis call |
| --------------------------------------------------------------- | ---------------------------------: | --------------------------: |
| Estimated tokens: used input declarations and all calls/replies |                          1,934,472 |                      58,840 |
| Estimated tokens: entire catalog and all calls/replies          |                          3,027,415 |                   1,151,783 |
| Elapsed seconds, including startup and cleanup                  |                             29.132 |                      19.927 |
| CPU seconds, process family                                     |                             33.694 |                      23.399 |
| Peak sampled process-family RSS bytes                           |                      1,435,963,392 |               1,334,128,640 |

Token counts are tokenx estimates of actual SDK advertisements, arguments and
complete replies, including follow-up reads and export. JSON-RPC envelopes,
initialization and actual model usage are unmeasured. Advertisements were
explicitly full; main's compact-default catalog cost is not measured by this
comparison. SDK/Ajv/token instrumentation is included in elapsed/CPU/RSS; its
separate cost is unmeasured. OS caches were warm, with fresh sessions/workers.
There is no storage-cold or statistical study and no stable latency or underlying
analysis-speedup claim. The current single pair does not establish a latency
trend; earlier slower selected runs remain in historical
records. Profiles sample descendant-task RSS every 20 ms. Analysis and test commands use
CPU affinity 0,1; each profile has an 8 GiB/420 s guard, and no successful qualifier
hit either guard.

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

## Projected data and registration patterns

The shared navigation owner now follows a destructured initializer's lexical
own literal fields. It no longer claims an entire registry when only its query
property supplies navigation data. Renamed/nested fields use the same resolver
and cached effective-field owner. Rest copies reuse semantic copy-path and key
selection metadata: excluded object fields and array prefixes remain independent,
while selected query values are owned as data. Unresolved dynamic keys, accessors
and indices after a spread remain conservative. Independent siblings stay visible.

Registration/path owners normalize wrappers and resolve stable field aliases
before generic constants are admitted. This preserves optional pattern syntax
such as `/users/:id?` without inventing `/users/:id`; a separate explicit URL
navigation still keeps URL query semantics. Resolved literals retain initializer
segment ranges. Ten regressions failed on the prior runtime (111 controls passed). Three
additional callable-scope cases failed against the first fix. All 178 scanner
tests now pass. Source ownership follows possible lexical identities while
destination inference retains its per-use freshness checks. The explicit
URL-navigation control already passed before the correction and remains covered.
Full/compact historical SDK reads after source deletion and both browser adapters
exercise independent-route retention, query exclusion and optional patterns.

Ten additional rest-copy regressions failed against the previous qualified
runtime, with 126 existing controls passing. All 178 scanner tests now pass.
The iterative selector charges work before retaining slots and shares object
field parsing, copy-path normalization and key selection with the binding owner.
Full/compact retained SDK queries and both browser adapters exclude route-shaped
rest payload data while preserving excluded route siblings.

## Recognized navigation and active defaults

Fourteen new cases failed against the previous runtime (142 tests passed):
ordinary array writes/string replacements were emitted as navigation, while
unused destructuring defaults hid independent routes. Six new controls already
passed, covering scalar aliases, actual used defaults and recognized navigation.
All 178 scanner tests now pass. Call classification admits only recognized sinks
to the positive navigation interpreter; its obsolete recognition mode and branches
are removed. Data strings/aliases do not return through generic constants.
Ownership reuses the semantic owner's inactive-source predicate before following
initializers. Full/compact historical SDK views and both browser adapters retain
independent unused defaults and exclude array/string data paths.

## Literal-selected data branches

An independent follow-up reproduced literal-inactive query references hiding
independent routes. Twelve new cases failed on the prior runtime, with 166 tests
passing (including ten new actual-selected-value controls). All 178 scanner tests
now pass. The existing with-scope syntax truthiness implementation now lives in
the AST value owner and is reused by both consumers; its old private copy is
removed. Ternary, &&, || and ?? value edges preserve definitely unselected lexical
sources. Bindings and conditions outside that helper remain conservative, without
executing source or claiming runtime reachability. Existing require-link,
builtin-default and Electron identity suites verify the moved helper consumer.
Both SDK profiles after source removal and both browser adapters preserve the
independent literal-inactive route.

## Executed checks and limits

**808/808 source/owner regressions** and **98/98 compiled
worker/public CLI/SDK/schema tests** passed on the qualified runtime, including
current-main CDP observation-window boundaries. Typecheck/lint passed through
`npm run check:fast`; final documentation validation is recorded separately.
The 98 distinct public tests run as 15 suites together and the selected-path
identity suite separately, retaining its original 30-second deadline. The first
fix exposed query data in two retained-SDK checks and hit that deadline in the
concurrent identity check; the failed attempt is preserved in JSON.
The public suite exercises exported-Evidence reads after source deletion,
large bounded facts, source selection, retention, cancellation, SDK recovery,
source-to-bundle integration and every advertised tool schema.

Seven condition-only/reference-edge regressions failed before the earlier636 correction
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

The earlier browser CI failure was independently reproduced on clean main `8413ec08f`:
the stalled-handshake fixture inherited a 20-second command deadline but its test
guard waited 12 seconds. CI fix #6186 explicitly selects 2000 ms for that case and
records it; the original guard and timeout, cancellation, socket release, policy
restoration and target reuse checks remain. The complete local real-browser
verifier then passed on Chrome 156 with verified cleanup. GitHub CI run39696167922
passed the fix on Chrome 155.0.8059.84, also recording the selected deadline and
zero owned descendants. The exact before/after profiles and verified merged tree
are in JSON. The baseline stopped early, so no speed comparison is claimed.
The old dependent #6019 run was cancelled; this head now contains the fix and
requires fresh CI.
No claim is made for complete application routes, live route execution, private
issue samples, external cloud clients or Windows/macOS provider execution.
