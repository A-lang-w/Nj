# Static JavaScript route inventory verification

Issue: [#4772](https://github.com/morluto/rea/issues/4772). Tested runtime:
`6c7a72505815f72a483b2acccbf09bfe71d5097e`, tree
`777b93e265f704f1b0af0751449e37ec0bbe2edf`, on main base `6d356b843`.
The accompanying JSON retains corpus digests, matched workflow measurements and
material failed qualification attempts. Later verification-only commits do not change runtime code.

## Inputs, oracle, and coverage

Downloaded the 29 script URLs referenced by the nextjs.org homepage
(1,533,098 bytes) and 38 referenced by ui.shadcn.com (2,465,078 bytes), preserving
original URLs, byte counts and SHA-256. All saved bytes were independently
rehash-checked before writing this record. Sources were read as data.

Production isolated source workers completed 65 of 67 analyses with a 512 MiB
old-space choice and 15-second per-source deadline. Two roughly 229 KiB framework
chunks timed out; their sources and unknown coverage remain visible. The complete
probe took 216.516 s elapsed, 321.240 CPU s and 488,484,864 sampled peak family RSS
bytes. No process-family memory guard stopped it. The static graph's semantic
projection capacity was explicitly one node; route syntax is collected before
semantic projection, and this choice is not silently imposed by the feature.

The shadcn corpus yields 18 `/docs` patterns, 31 detector/site occurrences, and
partial source coverage. Independent direct-byte inspection of its
[86,218-byte production chunk](https://ui.shadcn.com/_next/static/immutable/chunks/0ftd4gqztonqp.js)
finds exactly those 18 unescaped quoted `/docs` literals, including 12 direct
`href` properties. SHA-256:
`45c6ead1e08cc578464e7a0c6b2e6764d7af83f99039e291f288a971b988b3fc`.
This checks declared static candidates; it does not establish served pages.
The nextjs.org capture yields zero supported rooted candidates and excludes 128
unanchored path constants. This is a coverage limit, not a zero-route claim.
No lazy chunk discovery, live application execution, or complete route denominator
is qualified by these homepage captures.

Public CLI and the official MCP SDK both analyzed the real shadcn source and
returned the same 18 patterns. Caller-selected `source_paths` retained the complete
38-file inventory but analyzed only this chunk. The other sources stayed unknown.
SDK-converted input and output schemas passed Ajv 2020-12 validation and actual
request/reply validation.

A separate real Chromium 156.0.8078.4 process, owned and cleaned up by REA's existing
verifier lifecycle, compiled this production chunk with `Runtime.compileScript`
and `persistScript` in a blank local page. It was never run. Actual CLI and SDK
`analyze_web_bundle` calls captured that inert source through CDP and returned the
same 18 patterns, original source URL and exact SHA-256. Parsing and enumeration
of this selected source were complete; application route coverage stayed unknown.
The verifier took 12.163 s elapsed, 14.068 CPU s and 2,105,151,488 sampled peak family
RSS bytes. Browser-group/profile cleanup succeeded. This qualifies the real
passive provider boundary, not behavior of the published application's UI.

## Equivalent delivery workflows

Both fresh SDK sessions used the same source selection, semantic-node budget,
512 MiB worker heap, 15-second source timeout, and `/docs` route query with path,
confidence, mechanisms and retained provenance. Both retained the identical parent Evidence ID
`ev_bfcb4e0a8eea576f4ca5b501b633d265f65d15ef9c9b234250e90c822a0d759d`,
performed three additional historical reads, and exported the Evidence bundle.
OS caches were already warm; no storage-cold or statistical speed claim is made.

| Measured complete workflow                                      | Complete delivery then route view | Selected view in analysis call |
| --------------------------------------------------------------- | --------------------------------: | -----------------------------: |
| Estimated tokens, used input declarations + all calls/replies   |                         1,934,630 |                         58,225 |
| Estimated tokens, entire advertised catalog + all calls/replies |                         3,016,099 |                      1,139,694 |
| Elapsed seconds, including client startup and cleanup           |                            15.329 |                         14.551 |
| CPU seconds, process family                                     |                            20.015 |                         18.755 |
| Peak sampled process-family RSS bytes                           |                     1,565,618,176 |                  1,368,326,144 |

The primary question took two tool calls with complete delivery and one with
selected delivery. For that question alone, used input declarations plus complete
SDK replies estimate 1,907,693 versus 11,248 tokens. The full analysis reply was
6,194,453 SDK JSON bytes, versus 28,885 for the route page. Token numbers use
`tokenx` on actual declarations, arguments and full SDK replies; they are estimates,
not actual model usage. JSON-RPC initialization/envelope cost is unmeasured.
The entire catalog remains expensive and is included separately rather than hidden.

Complete-mode historical reads took 30.1, 17.2 and 11.8 ms. Selected-mode follow-up
reads took 2452.3, 23.5 and 20.9 ms: the first historical call includes cold client
and tool preparation that was not separately profiled. A weak cache of validated
immutable snapshots does not establish zero preparation cost. Projection reduces
output; it does not skip source analysis or complete Evidence materialization.

Process-family RSS sums live descendants discovered through every task's child
list at 20 ms intervals; it is sampled, excludes the observer, and can miss shorter
peaks. CPU uses waited child-family usage with inherited shell usage removed.
Every profiler records payload status and an 8 GiB family / 420-second stop guard.

## Checks and failed attempts

- Public CLI/SDK, old WebMCP declarations, route facts and retained views: 42/42.
- Existing web analyzer, worker schemas and Evidence service: 127/127.
- Real production worker, browser MCP and retained application boundaries: 22/23
  initially, with one existing 20-second browser aggregate test timeout while
  sharing two CPU cores. The isolated browser/legacy-route-property run passed
  6/6, including that test in 12.810 s. The same three-file command then passed
  23/23 on the main base (51.546 s elapsed / 88.827 CPU s) and current branch
  (46.037 s / 86.283 CPU s), with no timeout change. The initial timeout was not
  reproduced; its cause remains unproven. All attempts remain recorded.
- `npm run check:fast`: passed type checking and lint.
- `npm run docs:check`: passed, including five README consistency checks.

The first internal sequential probe exhausted its configured 3 GiB V8 heap; it is
not a passing result. A subsequent harness incorrectly used URL module paths,
then overlapped build cleanup with its remaining worker jobs; it is invalid.
The qualifying run corrected relative paths and froze the runtime. Early exported
Evidence tests used an unsupported CLI option and then supplied a bundle to a
one-record Evidence source; corrected tests authenticate the extracted parent
record after deleting the original application. One benchmark had a JavaScript
brace syntax error before any MCP request. These attempts remain in the JSON.

No live published-page, Windows/macOS provider behavior, real private issue sample,
route reachability, or complete application route count is claimed.
