# Portable managed CLI member views

Issue #5148 / PR #5167. Baseline `main@d2015e94f32a51b898918b5b39b374c134119fd5`;
feature integrates the original `7b3ed4d025edd24d062cde0327a53bd311e174fc`.
The measured production-file SHA-256 manifest is in [managed-cli.json](managed-cli.json).
These are working-tree measurements; subsequent formatting does not add a new
performance cohort.

## Question and independent checks

Report identity, selected type, source coverage, the total method count, the first
eight complete method records, and the first sixteen assembly-wide MemberRef
records, including continuation coverage. Keep complete original Evidence available.
The question deliberately does not ask for every method or reference.

Public artifact: [Newtonsoft.Json 13.0.3](https://www.nuget.org/packages/Newtonsoft.Json/13.0.3),
from the NuGet flat-container archive. The 2,441,966-byte archive SHA-256 is
`872fc189e638ab1056555b03aaa38f68bcb54286e221aa646eb1129babf63c77`.
Selected member `lib/net6.0/Newtonsoft.Json.dll`, 712,464 bytes, SHA-256
`22c649f75fce5be7c7ccda8880473b634ef69ecf33f5d1ab8ad892caf47d5a07`.
Package version 13.0.3 is distinct from metadata assembly version 13.0.0.0.
No library code is executed; REA parses PE/CLI statically.

An independent Python oracle uses `dnfile==0.18.0` and `pefile==2024.8.26`.
It finds 494 TypeDefs, 4,208 MethodDefs and 2,149 MemberRefs. The selected
`Newtonsoft.Json.JsonConvert` has 72 methods. Every trial checks all 72 method
tokens, names, RVAs and original signature hashes, plus the sixteen returned
MemberRef tokens, names and signature hashes, against this oracle. This does
not independently establish complete CIL semantics or opcode correctness.
The full parent Evidence and requested answers are identical across all twelve
trials; returned rows equal the exact parent slices. Selection and source
coverage remain distinct from page exhaustion. MemberRefs remain assembly-wide.

## Completed-task cost

Linux x64, Node 24.18.0/npm 11.16.0. Three alternating pairs per cache condition,
serial, one CPU; 4 GiB hard / 3 GiB early-stop family guard, no swap, 192-task
ceiling. Every task includes actual selected-command help, all CLI calls,
provider parsing, bundle publication/authentication, local answer extraction
and oracle comparisons. Build, download, oracle preparation and warm priming
are excluded. OS page cache is uncontrolled. No build/test overlapped timing.

Complete mode starts two CLI processes (help plus analysis). Selected mode starts
five (two help commands, summary/publication, methods page, MemberRef page).
Cold disables the Node compile cache; warm primes the exact workflow once per
runtime/mode, then still starts fresh processes with isolated HOME each trial.
All trials complete with verified process cleanup and no OOM/resource-stop event.

| Whole task, median                              | Complete | Summary + two pages |
| ----------------------------------------------- | -------: | ------------------: |
| Estimated context tokens, both cache conditions |  451,373 |              13,078 |
| Cold wall seconds                               |    5.562 |              12.516 |
| Cold family CPU seconds                         |    5.317 |              12.240 |
| Cold kernel family peak MiB                     |    387.9 |               387.6 |
| Warm wall seconds                               |    5.158 |              12.175 |
| Warm family CPU seconds                         |    4.928 |              11.881 |
| Warm kernel family peak MiB                     |    397.4 |               395.7 |

Context estimates include the question, supplied command recipe, all logical
argv, actual help and stdout. Tokenizer `tiktoken==0.12.0`, `cl100k_base`.
The reduction is 97.1% for this fixed task. There is no model invocation;
actual billed/native-agent usage, reasoning and transport framing are unmeasured.
The memory counter is the kernel cgroup process-family peak including file
cache, not sampled RSS. Ranges and individual receipts are in the JSON.

This is an opt-in context/portability improvement with extra latency and CPU,
not a speed or memory optimization. Complete provider parsing and full authentication of file-supplied bundles
remain. Fresh managed Evidence is sealed at its producing factory and reused
without another payload clone, including low-headroom error projection. Complete output remains the default and is preferable
for small outputs or questions requiring every row. No cache or parser cap
was introduced.

## Existing native code composition

The unchanged baseline can already redirect full stdout to a file and select
rows in code. [The measured control](managed-cli-local-control.py) returns the
identical answer and retains the complete original Evidence. One cold run:
5.479 s wall, 5.253 s family CPU, 376.1 MiB kernel peak. Projection source,
original help and returned answer together estimate 10,345 tokens; the shared
question and launcher argv are excluded. This single-run control does not
establish stable performance or actual native-agent usage. It does demonstrate
that raw CLI reply savings are not universal savings over code composition.
The additive interface supplies authenticated reusable projections through the
same application/domain owner as MCP, without caller-maintained JSON slicing.

## Correctness and resource boundaries

The public CLI regression pages all eight managed collections after process
exit, target deletion and a working-directory change. Complete parent identity,
original row order, signatures, coverage and unknowns survive. Other tests cover
bundle tampering, exact multi-record identity, conflicting sources, existing
outputs, provider/publication failures, interrupted publication, cleanup retry,
and queued SIGINT/SIGTERM during authentication/projection.

Additional producing-boundary regressions verify heap admission before cloning
and hashing on publication and read, and exact cancellation identity. The first
three regressions failed when those fixes were removed. Review corrections seal
the freshly parsed/hashed managed Evidence at its existing factory, so the final
CLI error projection reuses the same authenticated immutable object when heap
admission refuses publication. Caller-owned provider input remains mutable and
independent. The writer receives the caller operation at creation, preserving
its exact cancellation cause, cleanup primary and lease through successful or
unresolved retries. Four projection/operation regression cases fail with these
producer fixes removed and pass when restored. No actual heap exhaustion is
needed for fault injection; all real tasks remain within the resource guard.
Bundle canonical-order validation now compares the existing ordinary JSON encoder's
bounded parts instead of allocating two whole-document strings. Native JSON key
order, omitted members, negative zero and Unicode/escaping comparison semantics
remain covered. Heap admission also reserves actual escaping expansion for keys
and values, including control characters and unpaired surrogates, before the
remaining scalar/manifest encoding. Its UTF-16 storage estimate is reported
explicitly; it is not a UTF-8 wire-byte count.

The owning operation is carried through regular-file JSON assembly and bundle
authentication, covering resource refusal as well as cancellation. Related
Evidence-file and historical-reference readers use the same boundary; superseded
error-relabeling wrappers are removed. Seven relevant negative-control cases fail
when these producer/encoding fixes are disabled and pass restored. The escaped
payload filesystem regression forbids whole-bundle stringification while checking
original raw text and authenticated identity.

All 356 focused tests across twenty-one files, `npm run check` and `npm run docs:check`
pass for this correction. These are fault-injection tests, not foreign-provider
measurements. Authentication/projection remains synchronous with cooperative
cancellation checkpoints between stages, not preemptible work.

## Shared-reader real-artifact regression

The existing Redux Toolkit 2.2.7 source/bundle task also completes through the
updated reader with default full output schemas and compact input schemas.
An independent Python SHA-256/path oracle verifies 180 historical files,
99 embedded source nodes and 210 candidate relations (33 strong-location rows,
147 unknown). Original signals and partial source coverage remain visible.
This uses the existing explicit semantic-node cap of one for static correspondence;
it does not establish equivalent semantic-graph coverage or behavioral equivalence.

One completed task: 17.543 s wall,
17.200 s family CPU,
938.1 MiB kernel family peak,
56,148 estimated context tokens (one input catalog,
all arguments and MCP text replies; excludes output schemas, framing and model
reasoning). Corpus/reference preparation was performed earlier and excluded.
This is a regression verification with resource observation, not a new paired
performance comparison. Actual model usage remains unmeasured. Details:
[managed-cli-shared-read.json](managed-cli-shared-read.json).

## Reproduction

Extract the selected DLL to a private lab as `Newtonsoft.Json.dll`. Create an
`acquisition.json` containing the URL, hashes, sizes and selected ZIP member
shown above; never commit the DLL. Prepare the independent oracle:

```bash
uv run --no-project --with dnfile==0.18.0 --with pefile==2024.8.26 python \
  experiments/analysis-efficiency/managed-cli-oracle.py /absolute/lab
```

Build baseline and feature separately with the pinned toolchain. Run each under
the shared resource guard, alternating complete/selected, selected/complete,
complete/selected for cold and warm. Use a new output directory for every run:

```bash
python3 experiments/analysis-efficiency/resource-run.py --observe-payload-exit -- \
  node experiments/analysis-efficiency/managed-cli-task.mjs \
  /absolute/runtime /absolute/lab /absolute/lab/pair-cold-1-selected selected cold
```

Save each guard output to the adjacent `pair-*.log`. Warm mode uses the lab's
mode-specific compile-cache directory; prime each identical workflow once first.
Supply a `measurement-inputs.json` with exact revisions and production hashes.
Then aggregate with:

```bash
uv run --no-project --with tiktoken==0.12.0 python \
  experiments/analysis-efficiency/managed-cli-costs.py /absolute/lab \
  --output /absolute/results.json
```

The original issue reporter's executable, foreign operating systems and actual
model sessions remain unverified. Two setup pilots, including one failed run
while compiled artifacts were absent after a typecheck failure, are excluded.
