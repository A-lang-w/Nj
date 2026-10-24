# Android manifest components verification, 2026-10-24

## Scope and revisions

PR #5025 adds a static component inventory to `inspect_android_package`, using
the namespace-aware decoded manifest already retained by the JADX adapter.
Activities, aliases, services, receivers and providers retain declarations,
qualified class names where established, export declarations/defaults,
permission provenance, intent actions/categories, service types, authorities
and alias targets. These facts do not establish runtime registration, class
existence, merged-manifest acceptance or APK authenticity.

The maintenance comparison pins baseline
`e3802c16491b772118ccdfa195c6b51c3a337bdd` (contributor head
`c822b00c4755e584ee081eb3e7587735b630e249` integrated with main) and candidate
`fde65b1d47c00c189e003c54ad2a2c1fc93b443a`. Both contain the feature;
this comparison checks the maintenance changes rather than estimating the
cost of answering the same question without the feature. Later main
integration is outside these measurements.

## Corrections and automated coverage

Alias target matching indexes valid spellings once for preceding activities.
It now adds a bare abbreviation only for a class directly inside the manifest
package. `sub.Target` is already a fully qualified name and cannot match
`com.example.sub.Target`; `.sub.Target` and the complete qualified name can.
The contributor had already removed repeated package expansion in
`c822b00c`; that performance correction is not attributed to this follow-up.
The existing 900 KiB package / 511 alias regression remains covered.

Older Evidence without this inventory now receives a fresh unavailable
inventory per parse. Mutating one parsed default cannot affect another parse.
Before the corrections, the new identity/default cases had 6 passes and 3
failures (two false alias matches and one shared default). Afterward all 50
component cases passed. The broader selected component/JADX/SDK-summary set
passed all 83 cases, and `npm run check:fast` passed on the measured candidate.
After integrating main `21a20306b4887ff8e6b614b6ae34a387cfbdf1d8` in
`cdc2829131045d85692cf4bbf0acb12f36f65af7`, the same 83 cases passed again.
`check:fast`, `docs:check` and test discovery (2,333 files, each once) also passed.

The parser bounds declarations and retained name/permission/authority copies
before expansion. Truncation, unknown export rules, unresolved names and
unsupported permission overrides remain explicit. The existing Android
summary includes the structured inventory and retains the complete manifest
for paging; no second inventory parser or new view implementation was added.

## Real engine and public APK

Linux x86-64, Node 24.22.1 / npm 11.16.0, existing full OpenJDK 17.0.20.1,
JADX headless MCP 0.7.1, one analysis worker, 512 MiB JVM heap and
`ActiveProcessorCount=2`. The task process family was restricted to CPUs 0/1.
The APK was read as an inert artifact and was never installed or executed.

- [Appium ApiDemos 6.0.18](https://github.com/appium/android-apidemos/releases/tag/v6.0.18),
  source revision `3e716ee04ef3390284bfab761e28da8c15c08143`, Apache-2.0:
  `ApiDemos-debug.apk`, 6,521,217 bytes, SHA-256
  `a9eecf37b26cd084855c530db81c2bb1b91f4c1b095a04f47aa7c20e2791f686`.
- [JADX headless MCP 0.7.1](https://github.com/1013503897/jadx-headless-mcp/releases/tag/v0.7.1),
  source revision `5844800a486d2248fa949b74c9896285f5b54de2`, JAR SHA-256
  `6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75`.

The engine reported package `io.appium.android.apis`, target SDK 33,
2,876 classes and 869 resources. The complete 152,541-code-unit manifest
produced 355 components: 331 activities, 11 services, 7 receivers, 4 providers
and 2 aliases. Component coverage was complete, with no projection limitations.
APK signature verification remained explicitly `not_performed`.

An independent Python ElementTree projection checked every component field,
declaration order, namespace attribute, class-name qualification, permission
source, export/default, intent value, authority and preceding alias target
against the retained XML on all six measured CLI tasks. It also rehashed the
APK. This oracle checks REA's projection of JADX-decoded XML; it does not
independently validate binary XML decoding or Android runtime behavior.
Interpretation was checked against Android's
[activity](https://developer.android.com/guide/topics/manifest/activity-element),
[alias](https://developer.android.com/guide/topics/manifest/activity-alias-element),
[service](https://developer.android.com/guide/topics/manifest/service-element),
[receiver](https://developer.android.com/guide/topics/manifest/receiver-element)
and [provider](https://developer.android.com/guide/topics/manifest/provider-element)
documentation.

An actual stdio MCP client launched the same engine, validated the advertised
input/output schemas with Ajv2020, checked every structured summary fact,
reconstructed the exact manifest in three 70,000-code-unit pages, made a warm
complete call, and re-read the retained summary. All normalized facts and
provenance matched CLI. Raw engine snapshots and Evidence IDs were not equated:
they truthfully retain session-specific private APK paths, Java map key order,
load duration and the commands actually run. The warm complete request does
not repeat the earlier load command. This client explicitly allowed a 64 MiB
receive buffer; default client-buffer compatibility was not established.

## Completed-task costs

Three alternating before/after pairs ran
`rea inspect-android-package <same APK> --json`. Each task launched a fresh CLI
and JVM. OS/JAR caches were already warm; cold disk and first bridge compilation
were not isolated. Full normalized results, target identity and provenance
were equal; raw per-run engine records were retained without rewriting them.

| Cost                                 | Before median (range)      | After median (range)       |
| ------------------------------------ | -------------------------- | -------------------------- |
| Estimated task tokens                | 135,958 (same in all runs) | 135,958 (same in all runs) |
| Elapsed seconds                      | 16.538 (14.666–37.511)     | 23.008 (17.756–24.777)     |
| CPU seconds                          | 18.811 (18.034–19.461)     | 18.191 (17.741–18.426)     |
| Sampled peak process-family RSS, MiB | 1,074.9 (989.7–1,087.9)    | 1,100.4 (1,074.1–1,123.6)  |

The elapsed and CPU ranges overlap; these runs establish no speed improvement.
The candidate's median sampled memory was slightly higher. Tokens use tokenx
1.3.0 estimates, not model billing: all complete CLI stdout plus the invocation
(135,926 + 32 tokens). Discovery, prompts, client parsing and envelopes are
outside this known CLI task.

The actual MCP verification task took 132.448 seconds, 40.767 CPU seconds and
1,820.8 MiB sampled peak family RSS, including handshake, full discovery,
schema validation, summary, three manifest pages, complete call, retained
summary and shutdown. An earlier verification attempt used an incorrect
cross-session raw-Evidence equality assertion and failed after 36.131 seconds;
that diagnostic attempt is not counted as a successful workflow.

For the successful MCP task, compact JSON payloads estimate 47,583 tokens for
the summary versus 135,759 for the warm complete Evidence. These are individual
payload estimates, not a measured whole-agent saving; the 222-tool discovery,
envelopes, repeated text/structured representations and earlier attempt are
not included in that payload comparison. CLI and MCP transports have different
costs and are not interchangeable baselines.

CPU comes from waited child-process accounting. RSS samples descendants every
50 ms, may count shared pages more than once and may miss short-lived children;
it is not a kernel-enforced process-family maximum. No Android device,
split APK, signature-verification, native-library or runtime coverage is claimed.
Issue #4448's broader enabled/process, metadata, URI-grant and location requests
remain open.
