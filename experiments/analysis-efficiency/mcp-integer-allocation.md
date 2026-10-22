# Integer validator allocation after MCP materialization

Issue #6236; PR #4360. Linux x64, 2026-10-22. Baseline `main@0b7213c89056a8e3a9e2bb785be210c8393d2899`; candidate `3228fb235d61d64d3a4ef3970265b6d08a75d7e7`. Production schema changes are in `6d4c812f6`; later commits add diagnostic instrumentation and evidence. This is a pinned comparison, not a claim about every later main revision.

Direct integer construction reduces retained REA V8 heap by about 9.6–9.7 MiB (5%) after a completed real Zellij metadata task. The three-pair ranges do not overlap in either profile. Normal completed-task timing and whole-family peaks vary by workload; there is no general latency or peak-memory reduction claim. Directory discovery already reads recorded schemas after #4424, so it does not materialize these validators. Context is unchanged.

## Change and compatibility

Replace 1,248 argument-free `z.number().int()` constructions with `z.int()` across 175 existing source files. Keep current shared schema owners, refinements, bounds, defaults and metadata. AST-token comparison against the baseline, after normalizing this construction and formatting, is equal for every touched source file. No new tools, provider effects, caches or response contracts.

The locked Zod 4.4.3 chained form retains a `ZodNumber` with a separate `ZodNumberFormat` check; direct construction uses the format itself. Incur 0.6.1 coerces argv strings only for `ZodNumber`. Existing CLI declarations and shared-input exceptions therefore retain the chained form. The actual compiled CLI registers 160 leaf commands; 104 numeric argument/option fields have identical results/errors in 974 installed-Incur parser cases across both runtimes, each field with an accepted probe. Fields are isolated from unrelated required options and no handlers are invoked. This is consumer-boundary coverage, not a real-engine claim.

Seven dependency-boundary variants match parsed values and complete error issues for 126 cases, including fractions, nonfinite values, strings/null/undefined and unsafe integers; 14 JSON Schema projections match in draft-07/draft-2020-12. Actual SDK advertisements match byte-for-byte in both profiles before/after materialization and across roles.

## Tasks, artifacts and bounds

Reuse the shared SDK task driver and independent ELF/section/zlib/JSON oracles from [the catalog study](mcp-input-catalog.md): official Alpine v3.21 x86_64 ripgrep 14.1.1-r0 and Zellij 0.40.0-r0. All 42/422 packages and 88/1,063 edges match the independent oracles. Select serde name/version/kind, repeat exact retained-parent reads twice, verify a canonical negative-offset refusal, export/check complete Evidence and confirm the unchanged directory. `kind: null` stays unknown. Targets are not executed; dependency presence does not establish runtime use. Acquisition URLs, archive/executable/oracle hashes and complete answers are in [the receipts](mcp-integer-allocation.json). Previously acquired public bytes are rehashed, not redownloaded.

Normal cohort: three alternating baseline/candidate pairs for each task × cold/warm server compile cache × default compact/full inputs: 72 trials, plus four excluded full-task warm priming runs. Separate diagnostic cohort: three alternating pairs per profile, cold Zellij tasks, 12 trials. All pass, with identical complete parent IDs/hashes and answers.

Node 24.18.0/npm 11.16.0; fresh client/server and HOME per trial, driver compile cache disabled. Each trial is serial, pinned to one CPU, 4 GiB hard/3 GiB early stop, no swap, at most 192 tasks. Before/after checks bind clean source, all 1,990 compiled JS/JSON assets, scripts and manifests; producer and resource-observer hashes are also bound. No OOM, resource stop or leftover payload processes. Whole-family measurements include SDK validation, extra calls, source/compiled audits and oracle checking; kernel peak includes file cache. Build/acquisition/oracle generation and priming are excluded. Warm uses a populated role/profile-specific Node cache; hit rate and OS page cache are unmeasured, and audits warm compiled-file pages.

## Normal task costs

Medians, baseline → candidate; all ranges are in the JSON. No inspector or diagnostic GC runs in this cohort.

| Task      | Cache | Input profile |        Wall s |  Family CPU s | Family peak MiB |
| --------- | ----- | ------------- | ------------: | ------------: | --------------: |
| directory | cold  | default       | 2.235 → 2.235 | 2.039 → 2.049 |   247.9 → 248.8 |
| directory | cold  | full          | 2.436 → 2.436 | 2.200 → 2.233 |   348.9 → 346.2 |
| directory | warm  | default       | 2.235 → 2.236 | 1.998 → 2.044 |   253.7 → 249.6 |
| directory | warm  | full          | 2.436 → 2.336 | 2.218 → 2.195 |   350.2 → 347.5 |
| ripgrep   | cold  | default       | 7.170 → 7.068 | 7.013 → 6.899 |   808.4 → 768.2 |
| zellij    | cold  | default       | 7.474 → 7.273 | 7.282 → 7.031 |   819.2 → 816.3 |
| ripgrep   | cold  | full          | 7.576 → 7.475 | 7.390 → 7.287 |   799.2 → 785.6 |
| zellij    | cold  | full          | 7.674 → 7.673 | 7.502 → 7.428 |   826.2 → 817.5 |
| ripgrep   | warm  | default       | 6.868 → 6.969 | 6.714 → 6.714 |   803.5 → 787.9 |
| zellij    | warm  | default       | 7.069 → 7.172 | 6.844 → 7.000 |   823.3 → 822.2 |
| ripgrep   | warm  | full          | 7.473 → 7.273 | 7.250 → 7.106 |   804.9 → 793.9 |
| zellij    | warm  | full          | 7.473 → 7.471 | 7.282 → 7.262 |   832.6 → 827.4 |

## Separate retained-heap diagnostics

The same completed SDK task launches only its owned REA process with `--inspect=127.0.0.1:0`. Four CDP calls verify the owned transport PID, read heap, force GC and read heap again. The endpoint comes from that child’s stderr; the PID is a cross-check of the owned endpoint, not sole ownership proof. The inspector socket closes before MCP shutdown. These V8 values exclude the client; diagnostic wall/CPU/family peaks include inspector and forced-GC overhead and are not normal-task timing results.

| Inputs  | REA V8 retained MiB |  Baseline range | Candidate range | Diagnostic wall s |         CPU s | Family peak MiB |
| ------- | ------------------: | --------------: | --------------: | ----------------: | ------------: | --------------: |
| default |   189.994 → 180.353 | 189.894–190.114 | 180.322–180.501 |     8.179 → 8.180 | 7.994 → 7.960 |   817.7 → 806.6 |
| full    |   191.392 → 181.721 | 191.368–191.420 | 181.665–181.963 |     8.478 → 8.277 | 8.283 → 8.093 |   825.1 → 822.3 |

A mismatched PID is rejected; removing only that guard makes the negative oracle fail. Both connections in that check use the same owned REA endpoint, with no foreign-process attachment. Aggregation rejects diagnostic GC in a normal trial. Reaggregating the historical #4424 receipts preserves every previous field except the updated aggregator source hash.

## Context accounting

tiktoken 0.14.0 / cl100k_base estimates, **not actual model usage**. Both roles have identical task estimates and advertisements.

| Profile | Input directory once | Directory task | ripgrep task | Zellij task |
| ------- | -------------------: | -------------: | -----------: | ----------: |
| default |               49,670 |         50,840 |       54,027 |      53,947 |
| full    |              205,744 |        206,914 |      210,101 |     210,021 |

Task projection includes question/recipe, server instructions, one unchanged name/description/input-schema directory, every tool argument/text reply and discovery prompt directory. Raw SDK directory costs separately count all observed lists, including output schemas: 756,173/912,444 tokens and 2,935,197/3,587,841 bytes per default/full list; analysis lists twice. SDK initialization/framing, model reasoning and actual usage are unmeasured. Fewer allocated schemas do not imply fewer tokens.

## Validation and reproduction

- Both runtime builds and all six static checks plus architecture guards pass. 5,972 source/contract/public CLI/MCP tests pass across 323 files; four skip for unavailable/guarded coverage. Includes real SQLite CLI/MCP record/column selection and JavaScript heap/deadline preservation. A first direct schema-validity invocation lacked generated catalog metadata; the supported focused entry generates it and all 15 cases pass. No production or timeout change was needed.
- All 84 measured tasks and four warm priming tasks pass independent oracles, canonical refusal, parent/directory identity and owned cleanup checks. This does not verify external Hopper/Ghidra/IDA, Android devices, all providers or foreign OS behavior. The earlier macOS numbers in #4360 describe a different revision/platform and are not combined with these results.

Build the pinned baseline/candidate in separate clean worktrees with the locked toolchain. Use the candidate’s producer scripts for both roles. `measurement_inputs` in the JSON records the complete matrix, questions/recipes, runtime bindings and producer hashes; extract it unchanged as the bindings file. Historical receipts require their matching producer revision. One normal task:

```bash
NODE_DISABLE_COMPILE_CACHE=1 node experiments/analysis-efficiency/mcp-input-catalog.mjs \
  --runtime "$CANDIDATE_RUNTIME" --bindings "$MEASUREMENT_INPUTS" --role candidate \
  --artifact "$RIPGREP_BINARY" --oracle "$RIPGREP_ORACLE" \
  --output "$NEW_CASE_DIRECTORY" --profile default --phase analysis --cache cold
```

Run each task through `resource-run.py --observe-payload-exit --` to obtain whole-family counters. For warm runs replace `--cache cold` with `--cache warm --cache-root <role/profile cache>` after one complete priming task. For the separate Zellij diagnostic tasks add `--diagnostic-heap` and use cold cache. Keep their case names/logs aligned with `measurement_inputs`; aggregate both cohorts with:

```bash
python experiments/analysis-efficiency/mcp-startup-costs.py "$RECEIPT_ROOT" \
  --output mcp-integer-allocation.json
```

The aggregator requires the recorded tiktoken version, exact catalog/parent/runtime/producer/guard identities, clean source, successful payload cleanup and matching matrix coverage. Default driver behavior continues without an inspector; the heap flag is confined to the experiment.
