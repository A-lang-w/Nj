# Frida status delivery and runtime-observation audit

Issue: [#5640](https://github.com/morluto/rea/issues/5640). Paired runtime base:
`17f581ff75d2b6cf643a997275e3e296f6c95760`. Exact package, patch, native input,
script and resource pins are in [the measurement record](frida-status-views.json).

The analyst requests a complete libc export inventory as retained evidence,
then checks the session's identity/state, script identity, queued message count
and truncation twice. The caller-authored script enumerates actual native module
exports in a controlled `/usr/bin/sleep` spawn, in chunks of 64. Both workflows
retain all captured messages and export the complete Evidence bundle.

The owning application service now accepts optional `detail=summary` for
`frida_session_status`. It reads the provider on every call, retains the original
complete Evidence, then uses the existing shared analysis-view projector.
The summary omits arbitrary message payloads and preserves all other status
fields, the retained message count, truncation, exact parent identity/digest,
provider and source parameters. Default and explicit complete delivery keep the
original Evidence identity and payload. Historical CLI/file projections use the
same projector. Source script decoding/representation Evidence and session
resource ownership are unchanged.

## Completed tasks

Native Frida Core/Node binding 17.23.2 captured 2,963 libc exports in 50 queued
messages. Independent checks establish the test-owned process birthtime, cgroup,
PID and libc mapping; the selected script digest and contiguous chunks are
checked against the complete retained parent. This does not independently
validate every native export address or establish global event coverage.

| Public SDK task                            | Complete | Summary |
| ------------------------------------------ | -------: | ------: |
| Large-history status reply, bytes per call |  462,831 |   5,597 |
| Small-history status reply, bytes per call |    2,643 |   5,595 |
| Large complete bundle, bytes               |  214,214 | 216,931 |
| Small complete bundle, bytes               |    2,335 |   5,051 |
| Large task elapsed, seconds                |   13.455 |  12.850 |
| Large task CPU, seconds                    |    5.631 |   5.168 |
| Large family peak, MiB                     |    580.8 |   579.9 |
| Small task elapsed, seconds                |   12.829 |  12.519 |
| Small task CPU, seconds                    |    4.764 |   4.537 |
| Small family peak, MiB                     |    573.5 |   575.9 |

Each SDK task discovers all 211 tools and executes eight public calls, including
two status reads and complete export. Small history contains two readiness/
completion messages. Fresh processes retain unflushed OS caches. The second
status read is a repeated live observation, not a cache hit. Every task includes
the controlled target's eight-second lifetime and verified natural exit.
Single pairs and this fixed wait establish no general latency/CPU advantage.
The first large summary status call was slower (221.6 versus 136.9 ms).

## Actual client context

Codex app-server 0.163.0 performs the native Frida workflow through the actual
REA MCP package. A deterministic local Responses/SSE fixture selects the calls;
there is no AI inference, paid model, model-quality or billing claim. The capture
contains all 211 schemas on each request and all history replays. `tiktoken`
0.12.0 `cl100k_base` counts compact JSON as a token estimate, not actual model
usage. Both completed paths use the same 300,000 tool-output budget.

| Completed client task                  |  Complete | Summary |
| -------------------------------------- | --------: | ------: |
| Requests / compactions                 |     8 / 0 |   8 / 0 |
| Whole request JSON token estimate, sum | 1,065,523 | 515,487 |
| Elapsed seconds                        |    15.023 |  15.347 |
| CPU seconds                            |     7.665 |   7.457 |
| Family peak MiB                        |     840.2 |   828.0 |

The completed task uses **51.6% fewer estimated request tokens**, including
schemas and continuations. It is slightly slower in this pair. At the client's
default output budget, complete status JSON is truncated and the task is
incomplete; summary status is intact and completes. That failed delivery is
excluded from completed-task gains. Three acceptance tests exercise invalid
JSON, incorrect counts/state/source linkage, missing chunks and wrong sessions.

The complete catalog plus all SDK exchanges also shrinks for the large case
(1,178,147 to 885,535 estimated tokens), but grows for the small case (882,286 to
885,564). These SDK exchange estimates include advertised output schemas and
are **not** actual model-input measurements. Summary delivery is optional
because its provenance wrapper costs more than a small complete observation.

## Resource accounting and limits

Runtime cases use one CPU, a 4 GiB cgroup ceiling, a 3 GiB early stop, no swap,
192 tasks, and host-memory admission/early-stop guards. Payload exit, descendant
cleanup and zero resource-limit/OOM events are verified while the scope observer
remains alive. Final whole-scope counters disappear after teardown and remain
unknown. Runtime family peaks stay below 1 GiB. Build/typecheck use separately
guarded larger limits; they are not runtime performance measurements.

Full queued messages still undergo validation, Evidence creation and retention;
this change primarily reduces delivery and repeated context. The extra derived
record increases retained bundle size. Long-lived heap retention, many-script
sessions, remote devices, binary messages and saturated capture budgets are not
performance-qualified by these native cases. Boundary tests preserve malformed
input, truncation, cancellation and cleanup semantics; simulated providers do
not qualify real remote behavior.

## Other providers in this audit

Inspector was measured against a test-owned real REA MCP process while it
handled a verified GitHub CLI Go build-information request. A concurrent native
CDP metadata subscription matched all 776 retained scripts by hash and reported
length: 565 file locations and 211 built-ins. The reply was 608,719 bytes;
capture retained 996/996 events with no reported drop/truncation. The qualification
run took 20.956 seconds, 18.076 CPU seconds and 987.4 MiB peak family memory,
including the independent oracle. This is not a paired performance cohort,
global completeness proof, source-byte validation or evidence of script
execution. Only `Runtime.enable` and `Debugger.enable` were sent. A prior
post-capture oracle missed 25 historical rows and was rejected; it does not
establish an Inspector regression. Existing raw-null delivery, grouped location
validation and eight-worker projection were already present and were preserved.

ADB's configured default executable is unavailable on this host, and no real
device is qualified. This audit makes no ADB device-performance claim. Inspector
selection/caching and Frida queue/filter redesign remain unimplemented without
an equivalent completed-task measurement that justifies them.

The existing bundled Frida verifier also returned functional success, but its
1,500 ms fixture outlived the verifier's 500 ms observation. Its payload-exit
cleanup receipt was therefore unverified and is excluded from qualified
resource/performance results. That unchanged verifier has no process birthtime
stamp to safely wait on an arbitrary later PID. The paired harness instead owns
the paused spawn and records birthtime/cgroup before resume, then waits for the
original target's natural exit. No PID-only cleanup or target-kill policy was
introduced.

## Reproduction

Use the pinned Node/npm toolchain and native Frida dependency. Freeze separate
baseline/candidate built packages and install the same locked dependencies.
Run each case independently with the resource observer:

```sh
python3 experiments/analysis-efficiency/resource-run.py --observe-payload-exit -- \
  node experiments/analysis-efficiency/frida-status-queries.mjs \
  --runtime /absolute/built-package --output /absolute/new-case \
  --capture libc --detail summary
```

Repeat with `--detail complete` and `--capture small`. For actual-client captures,
`frida-status-wire.py --help` names the runtime, pinned Codex and Node executables,
output directory and selected script file (`selected-script.js` from the SDK
case). Use both `--mode complete`/`summary` and `--budget 300000`/`0`.
`frida-status-costs.py` checks task/resource receipts and counts complete requests.
The first wire attempt used ambiguous suffix matching for load/unload names;
the fixture now selects exact operation names. Failed attempts remain outside
the performance cohort. No production behavior changed to accommodate them.
