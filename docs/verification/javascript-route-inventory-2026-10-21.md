# Static JavaScript route inventory verification

Issue [#4772](https://github.com/morluto/rea/issues/4772). Qualified runtime
`484a72ea1b9621c97adf56dbd87a9bcd2e322602`, tree `610da2e518fdcb3f732392ca22d4fdc4bb55a3b1`,
integrates main `bd5d189a8f8aeea669bcb93e68af6c046b567939`. Recorded at
`2026-10-22T04:26:48.167Z`. Subsequent verification-only
commits change these reports. The [JSON record](javascript-route-inventory-2026-10-21.json)
pins original inputs, exact commands, profiles, failed controls and historical revisions.
Current-head GitHub CI and automated review must be checked separately.
The current integration preserves main-selected analysis environments and ASAR
admission while retaining route delivery options. The staged-code hook now runs
lint fixes before formatting, correcting the producing order behind the prior
CI format failure; the complete local CI static gate passed.

## Current implementation and executed checks

Shared source analysis produces stable route, occurrence, source and gap facts.
CLI and MCP use the same retained Evidence views, with filtering, selected fields,
batch identities and pagination; complete source Evidence remains accessible.
Coverage and explicit unknowns survive compact delivery and source deletion.
Selected CLI delivery requires a complete Evidence export; MCP retention is
checked before analysis. Immutable snapshots use weak identity caching with
parent identity checks; live target state is not cached.

Route scanning reuses semantic bindings, mutation, literal-field, reference and
truthiness owners. Navigation data ownership excludes query/search/hash values,
callee/projection/predicate edges and definitely inactive branches while keeping
independent lexical routes. Registration patterns preserve optional syntax and
initializer ranges. Unrecognized array/string methods do not become navigation.
Rest-copy exclusions, unresolved projections, mutations and cycles retain their
appropriate independent facts or unknowns. Next page classification shares one
owner, including private folders, encoded public underscores and unresolved
interception context. Source ranges use one-based lines, zero-based UTF-16
columns and exclusive ends.

Source/fact and inventory budgets are 8 MiB; optional facts fit the actual
remaining combined-result budget. Selected pages include the sealing digest
within their 1 MiB bound. Cancellation preserves earlier facts and Evidence;
worker cleanup and capacity failures retain typed outcomes.

The current integration uses main's canonical Evidence publication/cleanup owner
and deferred MCP runtime/catalog. CLI delivery explicitly produces JsonValue and
projects the two publication receipt scalars without cloning complete Evidence.
The canonical web-bundle state and coordinate owners replace duplicate types.
The coordinator parser-import boundary remains covered.

**811 source checks and 115 compiled public checks passed**,
including 178 scanner regressions, actual full/compact SDK profiles, both JSON
Schema dialects, source selection/deletion, retained reads, cancellation,
recovery, real workers and CLI/browser adapters. The current public selection additionally covers ASAR admission, selected
environment, CLI resource closing and Electron file scope. The previous 153
startup/publication boundary checks remain pinned to their executed runtime.
Selected-path identity runs separately with its original 30-second deadline.
Typecheck/lint passed; documentation checks are recorded in JSON after generation.
The main-baseline service-worker deadline correction [#6186](https://github.com/morluto/rea/pull/6186)
is included; it retains the original stalled-handshake assertions and test guard.

## Real production inputs and oracle

The full 67-script run below is pinned to runtime `896c682cf`, not repeated as a
current-runtime performance measurement. Shared parser/route/isolated-analysis/
view owners are byte-identical; acquisition/process changes have fresh public
workflow checks and fresh SDK/Chromium source analysis. Every saved script in
that pinned full-corpus run was rehashed and freshly analyzed
through production isolated workers, with one semantic projection node, 512 MiB
worker old-space and the existing 15-second source deadline. Application sources
were read as data. No source facts were reused in that pinned run.

| Homepage capture | Scripts |     Bytes | Completed | Route checkpoints | Rooted patterns |
| ---------------- | ------: | --------: | --------: | ----------------: | --------------: |
| nextjs-org       |      29 | 1,533,098 |        28 |                28 |               0 |
| shadcn-ui        |      38 | 2,465,078 |        37 |                37 |              18 |

The full task cost **202.819 s / 304.649 CPU s / 490,508,288 bytes peak family RSS**. Configured deadlines and partial/unavailable
facts are explicit. Zero supported rooted Next patterns does not establish zero
application routes. Lazy/server-only code, reachability and the full application
route denominator remain unknown.

Independent direct-byte inspection of the
[86,218-byte shadcn production chunk](https://ui.shadcn.com/_next/static/immutable/chunks/0ftd4gqztonqp.js)
finds exactly 18 quoted `/docs` patterns, including 12 direct href properties.
SHA-256: `45c6ead1e08cc578464e7a0c6b2e6764d7af83f99039e291f288a971b988b3fc`.
Every fresh SDK and browser verifier requires the entire sorted 18-pattern oracle,
original source identity, provenance and complete retained Evidence.

An owned Chromium 156.0.8078.4 compiled this source via
Runtime.compileScript/persistScript on a blank local page without running it.
Actual CLI and official SDK analyze_web_bundle calls passively captured it via
CDP and returned all 18 patterns, original URL and SHA-256. Source parsing was
complete, enumeration partial and application coverage unknown. Owned process
and temporary-profile cleanup succeeded. Cost: **9.650 s / 12.531 CPU s / 2,107,740,160 bytes peak family RSS**.

## Equivalent SDK task costs

Both fresh sessions list `/docs` patterns with confidence, mechanism and source
provenance, preserve complete Evidence, perform three retained follow-up reads
and export Evidence. They assert the same complete parent Evidence identity.
Measurements include the instrumentation and use full input advertisements.

| Delivery | Used declarations + all calls/replies, tokenx | Entire catalog + all calls/replies, tokenx | Task resources                                                |
| -------- | --------------------------------------------: | -----------------------------------------: | ------------------------------------------------------------- |
| Complete |                                     1,934,472 |                                  3,028,779 | 13.722 s / 18.162 CPU s / 1,639,522,304 bytes peak family RSS |
| Selected |                                        58,840 |                                  1,153,147 | 12.335 s / 16.332 CPU s / 1,332,797,440 bytes peak family RSS |

Tokenx counts actual advertised schemas, arguments and full SDK replies, including
exports and follow-ups; it estimates tokens rather than actual model usage.
Initialization, JSON-RPC envelopes and separate token-count instrumentation costs
remain unmeasured. Processes/sessions are fresh with warm OS caches; there is no
filesystem-cache flush, repeated statistical timing study or claim of stable
latency/analysis speedup. Default compact-advertisement costs are not measured.
CPU is payload process-family wait-rusage delta and RSS samples all descendant
tasks every 20 ms. Heavy tasks run sequentially on two CPUs with an 8 GiB family
RSS/420-second guard. No qualification guard fired.

The JSON preserves prior failures, source-owner corrections and their exact
before/after revisions. Historical CI/review does not establish the current head.
Private issue samples, complete application routes, live route execution,
external cloud clients and Windows/macOS provider execution remain unverified.
