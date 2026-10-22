# APK signing verification

Issue [#4537](https://github.com/morluto/rea/issues/4537), existing PR
[#4158](https://github.com/morluto/rea/pull/4158). Runtime `f85a887a05fa62d0675139746dbce6eba7548aee`,
tree `ff1f42613847e198988bf84dfb2d50d578084bdb`, integrates main `a4a548718d696d7329ffc7b9caa64ee72a215461` while retaining
contributor head `76445a83c8e6542131f7b38290ec749b3a199ba4`. The [JSON record](apk-signature-2026-10-22.json)
pins commands, inputs, resource profiles, failed controls and limits.

The selected-file provider owns ZIP/signing/PKCS#7 parsing and digest work.
The shared application workflow owns identity validation, cancellation and
Evidence retention. CLI/MCP use the same summary and signer/digest/lineage
projections; immutable report caches recheck parent subject identity. Selected
pages preserve identity links, source scope and unknowns after source deletion.
Complete source Evidence remains accessible and CLI compact delivery exports it.

## Executed checks

- **201 source tests /12 suites passed**, and uncached typecheck/lint passed.
  Tests ran on the exact staged tree; commit hooks left that tree identical.
- **408 compiled public tests /14 suites passed**, including15 advertised
  schema checks, both SDK input profiles, CLI/MCP parity, retained reads after
  deletion, batch/field/page semantics, partial v1/lineage facts, cached subject
  identity, cancellation/cleanup, stable readers and CI selection/required gates.
- The original real-toolchain verifier passed before and after: **23
  verifier-reported CLI/SDK cases**, including v1 RSA/EC, legacy v1+v2+v3,
  rotation, v3.1, source stamp, tampered bytes and forged declared digests.
  Forged declarations can match bytes while apksigner rejects their signature;
  REA preserves that distinction. Build Tools36.1.0/platform36 were downloaded
  from Google, checked against repository metadata and pinned SHA-256.
- Exact CI static checks passed. Documentation validation follows this generated
  report; current-head GitHub CI and review are checked separately.

The initial matrix had four failures and28 controls. Two missing/truncated
framing cases and one lost algorithm-field case were genuine; its universal
suffix-refusal assertion was incorrect and is withdrawn. The owner now checks complete
signer framing, matching signed/outer v3 SDK bounds and exact algorithm records.
Reports retain raw unsigned algorithm IDs, declared digest hex, signature lengths
and unknown algorithms. Real SDK signing exposed an extra empty signed-data
field accepted by Android readers. Scheme/signer/signed-data/record suffixes
now retain explicit uninterpreted counts instead of being mislabeled malformed;
required lengths and repeated v3 SDK bounds remain checked. Representation expansion is charged before report
allocation. Shared fixtures now produce full framing. No cryptographic signature
verification is claimed.

The larger public matrix exposed two old30s test timeouts. The SDK matrix now
passes its actual advertised definition; malformed stateless inputs share one
production stdio session while representative CLI cases remain. All original
assertions and deadlines are retained. Failed preparations and superseded runs
are explicitly recorded in JSON.

## Public artifact and resource evidence

The unchanged official [F-Droid APK](https://f-droid.org/F-Droid.apk) is
12,569,951 bytes, SHA-256
`19d51fad482239f6df6a99120e34513667e9a86d136dafdc4a211a68c3327b52`. SDK `apksigner verify -v --print-certs`
verified v3 and identified `43238d512c1e5eb2d6569f4a3afbf5523418b82e0a3ed1552770abb9a9c9ccab`; every task reproduces that
fingerprint and exports the complete parent report. URL, response metadata and
input identity are retained. Android code was never executed.

A distinct generated stress input adds a160MiB stored asset to that APK and
re-signs it with a generated fixture key. It is
180,350,384 bytes, SHA-256
`cf3a3936f90bb79dabe2598dc4290f8c47d10680993c054fe8cac9d391fadaaf`; apksigner verifies it. Three provider
calls per input check exact source identity, signer and content-digest equality.
Their first/repeated in-process timings are recorded separately. An additional
512MiB+1 sparse file is refused before whole-file allocation.

Whole resource probe: **2.047 s / 2.393 CPU s / 449,503,232 bytes peak sampled family RSS**. The whole-file
reader retains chunks and a concatenated buffer; its512MiB input cap is not a
512MiB process-memory claim. Selection reduces delivery and does not skip file
SHA-256 or supported digest analysis.

## Equivalent completed SDK task

Task: identify every declared v3 signer fingerprint in the unchanged APK and
export complete Evidence. The current complete and selected tasks export the
same parent Evidence identity. Earlier normalized facts differ because the
original report omitted raw algorithm details; all three answers and source
SHA-256 agree. The original baseline predates the later main integration;
whole-catalog changes include other upstream tools. Only the two current tasks
share identical advertised definitions and a complete parent identity.

| Delivery          | Used full input declarations + all calls/replies, tokenx | Entire catalog + all calls/replies, tokenx | Task resources                                                    |
| ----------------- | -------------------------------------------------------: | -----------------------------------------: | ----------------------------------------------------------------- |
| Original complete |                                                    4,156 |                                  1,140,214 | 3.282 s / 4.083 CPU s / 751,788,032 bytes peak sampled family RSS |
| Current complete  |                                                    5,246 |                                  1,157,394 | 3.612 s / 4.339 CPU s / 698,650,624 bytes peak sampled family RSS |
| Current selected  |                                                    4,230 |                                  1,156,378 | 3.508 s / 4.384 CPU s / 700,706,816 bytes peak sampled family RSS |

These are estimates, not actual model tokens. Counts include actual advertisements,
arguments, complete replies and exports; initialization and JSON-RPC envelopes
are unmeasured. Processes/sessions are fresh with warm OS caches. No disk-cold
or statistically stable timing claim is made. CPU uses payload-family wait-rusage
delta; RSS samples every20ms and sums descendant processes. Heavy tasks run
serially on two CPUs with8GiB/420s guards; no guard fired.

The added GitHub lane requires pinned SDK oracle tools and has no silent skip.
Local results establish Linux static-reader behavior. Windows/macOS APK behavior,
platform installation, authenticity, cryptographic signer/lineage validity and
v1 entry coverage remain unverified.
