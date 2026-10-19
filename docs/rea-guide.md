# REA (Reverse Engineer Anything) — Guide

Official sources only: github.com/morluto/rea, rea.tools, npm `rea-agents` (maintainer: morluto).

There is no separate "REA agent" process. REA = **MCP server + CLI + `reverse-engineer-anything` skill**, which turns your existing coding agent (Claude Code, Codex, Cursor, Gemini CLI, Grok Build, ...) into an evidence-aware reverse-engineering agent.

| Piece                             | What it does                                                                                                                                                | Where it goes                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| MCP server (`rea mcp`)            | Gives the agent tools (`analyze_javascript_application`, `decompile`, `xrefs`, process capture, ...)                                                        | Agent config (e.g. `~/.cursor/mcp.json`, `~/.claude.json`)            |
| Skill `reverse-engineer-anything` | `SKILL.md` + references (native, JS, Android, runtime, evidence workflows) telling the agent when/how to use the tools, handle Evidence, page large results | Agent skills dir (e.g. `~/.agents/skills/reverse-engineer-anything/`) |

Without the skill the tools exist but get used poorly.

## Contents

1. [Setup](#setup)
   - [Prerequisites](#prerequisites)
   - [Windows setup](#windows-setup)
   - [Linux install example (Debian 13)](#linux-install-example-debian-13)
2. [Usage](#usage)
   - [Best way to use REA (agent-driven)](#best-way-to-use-rea-agent-driven)
   - [CLI Evidence patterns](#cli-evidence-patterns)
   - [Limits and obfuscation](#limits-and-obfuscation)
3. [Evidence model](#evidence-model)
   - [Evidence records](#evidence-records)
   - [Residual unknowns](#residual-unknowns)
   - [Closing a residual unknown](#closing-a-residual-unknown)
   - [Hashing and identity (SHA-256)](#hashing-and-identity-sha-256)
   - [Evidence Bundle](#evidence-bundle)
4. [Obligation Ledger](#obligation-ledger)
   - [Overview](#overview)
   - [Schema](#schema)
   - [Closure semantics](#closure-semantics)
   - [Blocked vs. out-of-scope](#blocked-vs-out-of-scope)
   - [Audit trail requirements](#audit-trail-requirements)
5. [Architecture patterns](#architecture-patterns)
   - [Related patterns](#related-patterns)
6. [Design implications](#design-implications)
   - [For agents and users](#for-agents-and-users)
   - [For reconstruction and verification](#for-reconstruction-and-verification)
   - [For tooling and workflow](#for-tooling-and-workflow)
   - [Trade-offs](#trade-offs)
7. [Version history](#version-history)

## Setup

### Prerequisites

- Node.js 22.19+, 24.11+, or 26+ with npm.
- A supported agent that accepts local MCP servers.
- Native binaries: existing Ghidra (12.1.x; bridge verified with 12.1.4) + 64-bit full JDK 21+, or Hopper, or IDA. Static JS/Electron and .NET need nothing extra.
- Linux: a procps-compatible `ps` on PATH (required for Ghidra/JADX/firmware and static JS launches).

### Windows setup

1. Install Node.js 24 LTS (nodejs.org) and `npm install --global rea-agents`.
2. Download Ghidra 12.1.4 from github.com/NationalSecurityAgency/ghidra/releases and extract (e.g. `C:\tools\ghidra_12.1.4_PUBLIC`).
3. Install JDK 21 from Adoptium (adoptium.net, Temurin 21, x64 MSI).
4. Set the variables (persist with `setx`, then open a new terminal):

```powershell
$env:GHIDRA_INSTALL_DIR = "C:\tools\ghidra_12.1.4_PUBLIC"
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-21.x.x-hotspot"
setx GHIDRA_INSTALL_DIR "C:\tools\ghidra_12.1.4_PUBLIC"
setx JAVA_HOME "C:\Program Files\Eclipse Adoptium\jdk-21.x.x-hotspot"
rea doctor --json
rea providers --json
rea setup
```

Note: Windows Ghidra support is REA's "experimental P0 boundary" (see [docs/windows-ghidra-p0.md](./windows-ghidra-p0.md)). Setup never installs Ghidra, Java or Python.

### Linux install example (Debian 13)

| Component  | Version                  | Notes                                                                   |
| ---------- | ------------------------ | ----------------------------------------------------------------------- |
| Node.js    | v24.22.0 (+npm)          | User-local Node 24 install (system Node 20.19.2 left in place, too old) |
| rea-agents | 6.7.0                    | `~/.local/bin/rea` (-> `~/.local/lib/node_modules/rea-agents`)          |
| Ghidra     | 12.1.4 PUBLIC (20260921) | Existing Ghidra install (`GHIDRA_INSTALL_DIR`)                          |
| JDK        | Temurin 21.0.12.1+1      | Existing Temurin 21 install (`JAVA_HOME`)                               |

`PATH`, `GHIDRA_INSTALL_DIR`, and `JAVA_HOME` were set for the shell.
Setup: `rea setup --client cursor --yes` -> added only the `rea` server to `~/.cursor/mcp.json` (command `rea mcp`, with GHIDRA_INSTALL_DIR/JAVA_HOME env) and installed skill at `~/.agents/skills/reverse-engineer-anything/`. Preview first with `--dry-run`.

#### Gotchas

- System Node was 20.19 (unsupported); apt/NodeSource route was unreliable, so Node 24 was installed from the official tarball.
- `rea doctor` reports `installations: multiple` (`~/.local/bin/rea` and an older `/usr/local/bin/rea`, both 6.7.0). Make sure `~/.local/bin` comes first in PATH.
- npm warns that `frida` install scripts were skipped (`npm install -g --allow-scripts=frida` to allow). Only matters for Frida runtime capture.
- Setup is non-interactive whenever a stream is redirected; use `--client <id>` + `--yes`, and `--dry-run` to preview.
- Grok Bot is listed as "manual hosted connector / unsupported" for setup.
- Hopper, IDA, JADX, and Kuna were not configured in this example (`rea doctor`: `missing_analysis_engine`); Ghidra was.
- `rea analyze --provider ghidra` on a tiny gcc binary returned `binary_overview` in about 10s.

## Usage

### Best way to use REA (agent-driven)

1. Run setup once (`npx rea-agents setup` or `rea setup`), pick your agent, review proposed changes, approve.
2. Restart the agent so the MCP server and skill load.
3. Prompt with a **narrow, concrete question plus an acceptance criterion**, e.g.:
   - "Understand how search works in the Notes app, show me the evidence, and build a similar feature for my project."
   - "Use REA to inspect this binary. Why does 200 + 10% give 220? Cite the Evidence IDs and label each conclusion as observation, inference, or unknown."
   - "Analyze this Electron app. Find the renderer-to-main IPC path for clipboard writes, show the evidence, and list what remains uncertain."

#### Practical tips

- One specific behavior/feature at a time, not "reverse engineer the whole app".
- Static analysis first; runtime/process capture only when needed, in a safe environment.
- Ask the agent to cite Evidence IDs and label observation / inference / unknown, and list limitations.
- Only software you own or are authorized to examine.
- Keep updated: `rea update` (then re-run the setup command it prints) — REA ships frequently.
- For large targets use summaries / paged views instead of loading everything.

### CLI Evidence patterns

Each CLI call is a separate process, so **save** results to reuse them.

```bash
npm install --global rea-agents
rea analyze-javascript-application /abs/path/to/app --json > app-evidence.json
jq -c '{source: {kind: "inline", evidence: .}, view: {kind: "summary"}}' app-evidence.json > app-view.json
rea inspect-analysis-view app-view.json
rea analyze /abs/path/to/program --provider ghidra --snapshot /path/to/snapshot.json --json
rea evidence-import /path/to/bundle.json
rea evidence-export /path/to/bundle.json /path/to/canonical.json
rea compare /path/to/left.json /path/to/right.json
```

Real Electron apps can produce hundreds of MB of Evidence: save it all, then read views (summary, module pages). Snapshots reuse exact prior results when target bytes, operation and parameters match.

### Limits and obfuscation

REA has **no dedicated automatic deobfuscator**.

- **Native**: pseudocode, asm, strings, symbols, xrefs. Light protections are often workable. Strong packers, control-flow flattening, virtualization and anti-analysis leave stubs — decompiling an unpacking stub does not recover the program. The agent can write Ghidra/IDA scripts, use Frida runtime observation, and combine static + dynamic evidence.
- **JS/Electron**: recovers modules, imports, IPC, source maps (Wakaru in some paths). Minified code is partly usable via the semantic graph; heavy obfuscation means more unknowns and manual cleanup.
- **General**: every result carries evidence, confidence and limitations — you must verify. Commercial (especially Android) packers are a known gap. **Runtime analysis is NOT sandboxed** and runs with your permissions: use an isolated environment. Lawful use only.

## Evidence model

### Evidence records

A record holds:

- **Artifact identity**: SHA-256, format, architecture, byte ranges/paths.
- **Producer**: tool/provider, version, parameters.
- **Raw and normalized results.**
- **Confidence/authority**: observed / derived / inferred; tool vs analyst (authority).
- **Locations**: addresses, functions, source maps, JSON pointers.
- **Limitations and unknowns.**
- **Deterministic content-addressed `evidence_id`** — local paths don't affect identity; secrets and env values are excluded.

Why: tool -> Evidence -> stored ledger/bundle -> query / page / compare / cite. Conclusions stay linked to proof, and unknowns get recorded instead of guessed.
Features: retained/paged views, import/export/compare, snapshots, composition (higher-level results link back to source evidence, e.g. a view's `parent_evidence_id`), CLI/MCP parity.
Limits: it doesn't make decompilers more accurate; results must still be verified.

#### Real record from the smoke test (from a 6.7.0 JavaScript application analysis)

Top-level fields: `analysis_profile, authority, confidence, environment, evidence_id, evidence_links, limitations, locations, normalized_result, operation, parameters, predicate_type, provider, raw_result, relationship_coverage, subject`

```
evidence_id:    ev_4e1f4abc96ff467eb3e0b44bb3503bf6bad9493c1252e07cc30f5180db5e40b5
subject:        name=sample, sha256=f28f12c7...6796e, format=directory, architecture=null
provider:       rea-javascript-application "REA JavaScript application analyzer" v1
operation:      analyze_javascript_application
predicate_type: rea.javascript-application-analysis
authority:      shipped-artifact      confidence: derived
limitations[0]: "CommonJS and ESM binding relationships were recovered from inert syntax and resolved only within the inventoried artifact container."
limitations[1]: "JavaScript and HTML were parsed as inert text; bundle bootstrap code was never executed."
```

The summary view of it got its own ID `ev_ffd34c4c...4ace46` with `parent_evidence_id` pointing back at the record above.

#### Exact Evidence fields

- `evidence_id`: `ev_` + SHA-256 of the canonical semantic projection of the record.
- `raw_result`: the provider's raw output, or `null` (it is null in the sample record).
- `normalized_result`: REA's normalized form of the result.
- `confidence`: observed / derived / inferred (the sample is `derived`).
- `authority`: shipped artifact / controlled replay / analyst inference (the sample is `shipped-artifact`).
- `environment`: the capture environment (`null` for a static analysis).
- `limitations`: what the analysis did not or could not establish.
- Typed `locations` and links (`evidence_links`), e.g. `{"kind":"artifact-path","path":"artifact-root"}`.

- `analysis_profile`: the provider and its analysis parameters (`null` for provider-neutral inspection; set for Ghidra-backed runs, e.g. `{"provider":{"id":"ghidra","version":"12.1.4"},"parameters":{"target_format":"elf","architecture":"x86_64",…}}`).
- `relationship_coverage`: how completely relationships (calls, references) were covered by the operation.

`evidence-import` recomputes each ID and rejects tampered records or conflicting duplicates.

#### Nested IDs and inspection fields (observed in the Oct 2026 beta)

`inspect-artifact` returns one top-level `ev_` record whose `normalized_result` nests its own content-addressed IDs and inspection lists. Real excerpt (from a 6.7.0 run against a small C test program, IDs shortened):

```
normalized_result.inspection_id:            ai_ddf6f81a…fed4b3
normalized_result.subject.manifest_id:      agm_9b39bb1f…c9208738
normalized_result.subject.root_artifact_id: art_b1b6b1f0…1a77b3fc
normalized_result.substeps[0].substep_id:   ais_d4a958e2…4096a87   (carries its own ev_89d61d2b…)
normalized_result.observations[0]:          observation_id aio_711dce6f…, kind "root-manifest"
normalized_result.hypotheses:               []
normalized_result.contradictions:           []
normalized_result.unexplored_branches[0]:   branch_id aib_df825917…, reason "format-specific-analysis-required",
                                            next_probe.operation "open_binary"
confidence: observed
```

| Prefix | Identifies                                            |
| ------ | ----------------------------------------------------- |
| `ai_`  | One artifact inspection                               |
| `agm_` | Artifact graph manifest                               |
| `art_` | An artifact node (root or child)                      |
| `ais_` | One inspection substep                                |
| `aio_` | One observation                                       |
| `aib_` | One unexplored branch (with a suggested `next_probe`) |

`hypotheses`, `contradictions`, and `unexplored_branches` are fields of the inspection result inside `normalized_result`, not top-level Evidence fields.

#### Exploring Evidence (MCP and CLI)

- In MCP clients, don't load full results. Use `inspect_analysis_view` to get summary or paged views. Each view is its own Evidence record whose `parent_evidence_id` links back to the full result.
- Piped CLI variant:
  `jq -c '{source:{kind:"inline",evidence:.}, view:{kind:"summary"}}' app-evidence.json | rea inspect-analysis-view`
  **Tested on 6.7.0: this does NOT work.** The command requires its `<inputJson>` argument. With no argument it fails with `VALIDATION_ERROR … path inputJson … received undefined`, and passing `-` fails with `invalid_request`. These two forms do work:
  - `rea inspect-analysis-view app-view.json` (write the jq output to a file first)
  - `rea inspect-analysis-view "$(jq -c '{source:{kind:"inline",evidence:.}, view:{kind:"summary"}}' app-evidence.json)"` (inline JSON as the argument; this returned `ev_ffd34c4c…4ace46` for the sample). Very large Evidence may hit shell argument-length limits, so use the file form for those.

#### Provenance practice (5 steps)

1. **Run** the analysis.
2. **Save and retain** the full Evidence (`--json > file`, or retained MCP results).
3. **Cite** Evidence IDs for every conclusion.
4. **Record unknowns** (`unk_`) instead of guessing.
5. **Build obligation ledgers** so reconstruction claims close only with an owner, tests, a passing verifier, and no open unknowns.

### Residual unknowns

Residual unknowns are REA's durable record of questions that couldn't be answered. They keep "we don't know" from becoming a silent assumption or a negative fact.

#### What they are

Each is a versioned record with a stable `unk_…` ID, capturing:

- The open question
- Status (`open`, `investigating`, `blocked`, `contradicted`, `resolved`)
- Severity
- Domain
- Supporting and contradicting Evidence IDs
- Required authority or environment (when relevant)
- Revision history (previous revision digest to current revision digest)
- A resolution object once the question is closed

Real field list from a 6.7.0 record (from a 6.7.0 run against a small C test program): `unknown_id, revision, previous_revision_digest, scope_digest, question, status, severity, domain, supporting_evidence_ids, contradicting_evidence_ids, required_authority, required_confidence, required_environment, recommended_probes, relationships, resolution, mutation_evidence_ids, revision_digest`.

| Field                    | Values (from source)                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `scope_digest`           | 64-hex digest of the scope (e.g. the artifact SHA-256), or `null`                                                   |
| `severity`               | `low`, `medium`, `high`, `critical`                                                                                 |
| `required_authority`     | `shipped-artifact`, `controlled-replay`, `historical-reference`, `external-service`, `analyst-inference`, or `null` |
| `required_confidence`    | `observed`, `derived`, `inferred`                                                                                   |
| `recommended_probes`     | `[{ "operation": "…", "rationale": "…" }]`                                                                          |
| `relationships`          | `[{ "type": "depends-on" \| "related-to" \| "contradicts", "unknown_id": "unk_…" }]`                                |
| `mutation_evidence_ids`  | Evidence IDs of every mutation that created or revised this unknown                                                 |
| `resolution.disposition` | `verified`, `withdrawn`, `out-of-scope` (unknown-level, not an obligation status)                                   |

The ID is derived from the question, domain, and `scope_digest`, so the same question in the same scope keeps a stable identity across revisions.

**Beta note (6.7.0).** REA can record residual unknowns, but in the Oct 2026 beta `analyze` and `function` did not open any automatically, even for a deliberately ambiguous helper. Unknowns had to be recorded explicitly (session `record_unknown` or `createResidualUnknown`) before they could be linked from obligations.

#### Why they exist

Evidence records capture what was observed or inferred; residual unknowns capture what remains undetermined. Without them, missing information could be read as "nothing is there" or filled with a guess. REA keeps the gap explicit and linked to the Evidence that was examined.

#### How they relate to the rest of the model

- They live in the Evidence Bundle alongside Evidence records.
- Obligations list them in `residual_unknown_ids`; an unresolved unknown keeps the obligation from closing.
- When new Evidence answers the question, the unknown moves to a new revision with status `resolved` and a resolution citing the resolving Evidence IDs.
- The revision chain is preserved, so you can see how the unknown evolved.

In practice this keeps the trail honest: you can always see which questions were left open, which Evidence was considered, and whether a later observation closed them.

### Closing a residual unknown

1. Obtain Evidence that answers the question.
2. Update the unknown (`updateResidualUnknown` or its session equivalent) with `unknown_id`, the current revision as `expected_revision`, status `"resolved"`, and a resolution object:
   ```json
   {
     "disposition": "verified",
     "rationale": "Indirect call target identified by cross-reference analysis and confirmed by runtime trace.",
     "evidence_ids": ["ev_new_resolving_record_..."]
   }
   ```
3. REA creates the next revision, stores `previous_revision_digest`, and appends the mutation Evidence that recorded the update.

Rules: only a resolved unknown may carry a non-null resolution; `unknown_id` stays stable; contradicting Evidence can move the status to `"contradicted"` instead; withdrawn or out-of-scope isn't verified closure. Once resolved, it stops blocking obligations that list it (if their other conditions are met).

Agent tip: `list_unknowns`, gather evidence, resolve with the new IDs, then rebuild the ledger to check closure.

### Hashing and identity (SHA-256)

SHA-256 over canonical JSON is the basis for content-addressed identity across Evidence, residual unknowns, application graphs, and ledgers: deterministic, path-independent, tamper-evident.

**Evidence IDs.** `ev_<64 lowercase hex chars of SHA-256>`, hashed over the record's _semantic projection_: subject identity (artifact SHA-256, format, architecture), provider (id, name, version), operation and parameters, raw and normalized results, confidence, authority, environment, limitations, locations, and relationship coverage when present. The ID itself and local paths are excluded, so moving or renaming a file doesn't change it. Import recomputes the ID and rejects any mismatch.

**Canonicalization.** Before hashing, the projection is serialized as canonical JSON: keys sorted recursively, array order preserved, no insignificant whitespace, UTF-8. REA uses the `canonicalize` library (confirmed present in the installed 6.7.0 package). The JavaScript Application Graph follows RFC 8785 (JSON Canonicalization Scheme) for its `jag_<sha256…>` IDs.

**Artifact identity.** Artifacts are identified by the SHA-256 of their raw bytes (`"digest": { "sha256": "…" }` in the Evidence subject). Because that digest is in the projection, changing the bytes changes every Evidence ID that references the artifact.

**Residual unknowns.** `unk_…` IDs are SHA-256 of a canonical projection of question, domain, and scope; each revision carries a `revision_digest`, so the update chain is content-addressed.

**Higher-level digests.** The ledger's [`closure_digest`](#closure_digest) is SHA-256 over the canonical object `{schema: "ReconstructionObligationClosure", status, coverage, summary, reports, ownership_graph, dependency_graph, obligations, evidence_links, limitations}`. The `ledger_id` is `rol_` + SHA-256 over `{schema: "ReconstructionObligationLedger", evidence_ids (bundle record IDs), obligation_ids, closure_digest}` (source: `dist/application/ReconstructionObligationLedgerEvaluation.js`); Application Graph node and graph IDs hash their normalized semantic content; snapshots are identified by the content of the retained results.

**Consequences.** Deduplication (identical observations share an ID and can be reused), tamper detection (any semantic change changes the ID), path independence, and reproducibility (same inputs, same IDs and `closure_digest`).

**Not hashed.** Local filesystem paths, the ID field itself, transient session or transport metadata, and secrets or ambient environment variables (excluded from Evidence by design).

#### closure_digest

What it is (source: `reconstructionObligationLedgerClosureDigest` in `dist/domain/reconstructionObligationLedgerIntegrity.js`, `digestCanonicalValue` in `dist/domain/canonicalDigest.js`):

- **What is hashed.** It is SHA-256 (bare 64 hex characters, no prefix) over the canonical JSON of `{schema: "ReconstructionObligationClosure", status, coverage, summary, reports, ownership_graph, dependency_graph, obligations, evidence_links, limitations}`. Each obligation is hashed in full, including its `status`, `diagnostics`, `authority_references`, `residual_unknown_ids`, `unavailable_authority`, `required_next_evidence` and `binding`. Contradictions are covered through each obligation's `contradiction` diagnostics and the `reports` field.
- **Canonical form.** Object keys are sorted in RFC 8785 UTF-16 code-unit order, and array order is preserved. Reordering obligations or Evidence links therefore changes the digest.
- **`ledger_id` is not an input.** The relationship runs the other way: `ledger_id` = `rol_` + SHA-256 over `{schema, evidence_ids, obligation_ids, closure_digest}`, so it is derived from `closure_digest`.
- **One per ledger.** There is no per-obligation digest. Rebuilding from the same bundle, reviewed obligations, and manifest gives the same value; a rerun matched.
- **Validation.** The ledger schema recomputes the digest and rejects a mismatch ("Ledger closure digest does not match its contents"). The same check also recomputes `status`, `summary`, `coverage`, `reports` and both graphs. It runs when REA builds a ledger and wherever a ledger is accepted as input, for example `obligation_ledger` in reconstruction readiness. 6.7.0 has no standalone command that verifies a saved ledger file.
- **What it doesn't do.** It commits to the result, including a ledger whose `status` is `failed`, but it never makes any obligation `verified`. Status rules live in [Closure semantics](#closure-semantics).

#### Background: SHA-256 collision resistance

SHA-256 gives a 256-bit digest. Collision resistance is bounded by the birthday paradox at about \(2^{128}\) operations; preimage and second-preimage resistance stay at \(2^{256}\). As of 2026, full 64-round SHA-256 has no known practical collision. Published attacks reach only reduced-round versions (practical collisions around 31 steps, research results around 37–38 steps), and they don't extend to the full algorithm. It remains the standard for integrity, content addressing, Merkle trees, and signatures, which is why REA's IDs can rely on it. (It's unsuitable for password hashing because it's too fast; use memory-hard functions there.)

### Evidence Bundle

The portable, content-addressed container for the observational layer: what you export, import, compare, and feed into ledgers.

| Section                                                         | Contents                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **records**                                                     | Immutable Evidence v2 records (`ev_…`): subject identity (artifact SHA-256, format, architecture), provider, operation, parameters, `raw_result` / `normalized_result`, confidence (`observed` / `derived` / `inferred`), authority, environment, limitations, typed locations. `evidence_id` is a deterministic SHA-256 of the canonical semantic projection. |
| **unknowns**                                                    | Residual unknowns (`unk_…`) with revision history, status, severity, supporting and contradicting Evidence IDs, and a resolution when closed.                                                                                                                                                                                                                  |
| **artifacts / providers / environments / scenarios / captures** | Supporting inventory: artifact digests, provider identities, execution environments, recorded scenarios, process and runtime captures.                                                                                                                                                                                                                         |

**Invariants**

- IDs are content-addressed; local paths and the ID itself don't affect identity.
- Import recomputes IDs and rejects tampering or conflicting duplicates.
- Secrets and arbitrary environment values are excluded.
- Canonical export is deterministic JSON with stable key order.
- Snapshots keep exact prior results when target bytes, operation, and parameters match.

The bundle is the source of truth for observations; it doesn't decide whether a reconstruction claim is proven.

#### Bundle vs. unknowns registry vs. obligation ledger

| Aspect               | Evidence Bundle                               | Residual Unknowns Registry                          | Obligation Ledger                                                                                                                      |
| -------------------- | --------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose              | Store immutable observations and provenance   | Track open questions and how they evolve            | Decide which reconstruction claims are proven                                                                                          |
| Identity             | Collection of `ev_…` and `unk_…` records      | Versioned `unk_…` heads with revision digests       | `ledger_id` + `closure_digest` over the complete result                                                                                |
| Mutability           | Immutable records; new ones are added         | Revisioned, append-only history                     | Derived; rebuilt from bundle + manifest                                                                                                |
| What it proves       | "Observed or inferred under these conditions" | "Still open, or resolved by these Evidence IDs"     | Per-obligation status (`verified`, `unowned`, `blocked`, `out-of-scope`, …) and a ledger status (`ready`, `open`, `failed`, `unknown`) |
| Closure              | None (observations only)                      | `resolved` with a resolution object citing Evidence | Status `verified`: unique owner, fixtures, and a passing verifier of comparable authority                                              |
| Disposition handling | Explicit limitations and unknowns fields      | Status + resolution                                 | Input `disposition` on reviewed obligations; derived output `status`; blocked and out-of-scope never count as verified                 |
| Relationship         | Input to the other two                        | Linked from obligations via `residual_unknown_ids`  | Consumes bundle + manifest; unknowns keep claims open                                                                                  |

**How they fit:** the bundle captures what was observed and what's unknown; the unknowns registry makes open questions durable and versioned; the obligation ledger consumes both plus a manifest and gives a deterministic verdict whose `closure_digest` covers every obligation, status, unknown link, and Evidence reference. The ledgers build on the bundle without replacing the original records.

## Obligation Ledger

### Overview

- Built by `build_reconstruction_obligation_ledger` (MCP) or `rea build-reconstruction-obligation-ledger` (CLI).
- Input: one JSON object with three required keys: `evidence_bundle`, `reviewed_obligations` (may be an empty array), and `manifest` (`bindings`, `contradictions`). REA does not generate the reviewed obligations or the manifest bindings; you write them.
- Static graph facts create **candidate** obligations only; they don't prove runtime behavior. The ledger is conservative.

The ledger is identified by a deterministic `ledger_id` (`rol_…`) + `closure_digest`. Closure conditions, input dispositions, and output statuses are defined in [Closure semantics](#closure-semantics).

```
Evidence Bundle (ev_ records | unk_ unknowns | captures/artifacts/providers)
        |
        v
build_reconstruction_obligation_ledger
  - static graph -> candidate obligations
  - manifest supplies owners, fixtures, verifiers
  - unknowns/contradictions keep claims open
        |
        v
Obligation Ledger (obligations e.g. protocol.rpc.cancel; per-obligation status; ledger status; ledger_id rol_… + closure_digest)
```

```mermaid
flowchart TD
  subgraph B[Evidence Bundle]
    E[Evidence Records ev_...]
    U[Residual Unknowns unk_...]
    C[Captures / Artifacts / Providers]
  end
  E --> L
  U --> L
  C --> L
  R["Reviewed obligations<br/>input disposition active/blocked/out-of-scope"] --> L
  M["Manifest<br/>bindings, contradictions"] --> L
  L["build_reconstruction_obligation_ledger<br/>static graph gives candidate obligations<br/>manifest supplies owners, fixtures, verifiers<br/>unknowns and contradictions keep claims open"]
  L --> O["Obligation Ledger<br/>obligation e.g. protocol.rpc.cancel<br/>status unowned/characterized/implemented/verified/contradicted/blocked/out-of-scope/unknown<br/>ledger status ready/open/failed/unknown<br/>residual_unknown_ids, diagnostics, Evidence ID links<br/>ledger_id rol_… + closure_digest (deterministic)"]
```

#### Reading the diagram

1. **Evidence bundle.** Holds the raw inputs: evidence records (`ev_…`, immutable observations with provenance, confidence, locations, and limitations), residual unknowns (`unk_…`, versioned open questions linked to supporting and contradicting Evidence), and supporting artifacts, captures, and provider metadata.
2. **`build_reconstruction_obligation_ledger`.** Takes the bundle, the reviewed obligations (each with an input `disposition`), and a manifest, and turns static graph facts into _candidate_ obligations. Residual unknowns, missing authority, or contradictions keep claims from reaching `verified`.
3. **Obligation ledger.** Lists reconstruction claims, each with a derived output `status` and `diagnostics`. An obligation reaches `verified` only when the manifest supplies a unique owner, the required fixtures, and a passing verifier of comparable authority. The ledger also gets an overall status and is identified by a stable `ledger_id` (`rol_…`) and `closure_digest`.

This structure lets agents and humans tell apart "we observed this," "this remains unknown," and "this reconstruction claim is proven."

#### Layered architecture (image)

![REA evidence model: Evidence Bundle (content-addressed Evidence records and versioned residual unknowns with statuses open, investigating, blocked, contradicted, resolved) feeding build_reconstruction_obligation_ledger, which derives the Obligation Ledger (ledger_id rol_…, closure_digest) and its per-obligation statuses unowned, characterized, implemented, verified, contradicted, blocked, out-of-scope, unknown](./assets/rea-evidence-model.jpg)

_Caption: the IDs in the image are shortened placeholders; real `unk_` IDs are `unk_` + 64 hex characters. The text tables in [Residual unknowns](#residual-unknowns) and [Closure semantics](#closure-semantics) are authoritative._

The ledger as a whole carries `ledger_id` (`rol_…`) + `closure_digest`, which identify the complete result. Each reviewed obligation is submitted with an input disposition (`active`, `blocked`, `out-of-scope`); each output obligation has a derived `status`, `diagnostics`, `residual_unknown_ids`, and evidence links (`ev_…`). `blocked` and `out-of-scope` do not count as verified. See [Closure semantics](#closure-semantics).

### Schema

Produced by `build_reconstruction_obligation_ledger` (MCP) or `rea build-reconstruction-obligation-ledger` (CLI); turns authenticated Evidence into a deterministic list of reconstruction claims. The CLI returns an `ev_` Evidence record (`predicate_type: rea.reconstruction-obligation-ledger`) whose `parameters` repeat `ledger_id` and `closure_digest` and whose `normalized_result` is the ledger. Field lists below come from the 6.7.0 schema (`dist/domain/reconstructionObligationLedgerSchemas.js`); descriptions are a simplified view.

#### Top-level fields

| Field              | Meaning                                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `schema`           | Always `"ReconstructionObligationLedger"`                                                                                        |
| `ledger_id`        | `rol_` + 64-hex SHA-256 (derivation in [Hashing and identity](#hashing-and-identity-sha-256))                                    |
| `closure_digest`   | 64-hex SHA-256 over the complete canonical result. Same inputs, same digest                                                      |
| `status`           | Ledger status: `ready`, `open`, `failed`, `unknown` (see [Closure semantics](#closure-semantics))                                |
| `coverage.status`  | `complete` when `limitations` is empty, otherwise `partial`                                                                      |
| `summary`          | `total`, `required`, `verified`, `required_open`, plus count arrays `by_status`, `by_application_layer`, `by_evidence_authority` |
| `reports`          | `missing_owner_obligation_ids`, `missing_verifier_obligation_ids`, `contradicted_obligation_ids`, `residual_unknown_ids`         |
| `ownership_graph`  | `[{obligation_id, module_path, symbol}]` from manifest bindings                                                                  |
| `dependency_graph` | `[{obligation_id, depends_on_obligation_id}]`                                                                                    |
| `obligations`      | Output obligations (below)                                                                                                       |
| `evidence_links`   | Unique `ev_…` IDs referenced by any obligation                                                                                   |
| `limitations`      | Text; any entry makes coverage `partial`                                                                                         |

Real excerpt (from a 6.7.0 run against a small C test program):

```json
{
  "schema": "ReconstructionObligationLedger",
  "ledger_id": "rol_82da9e995a3972e844ea59b5f523aace865e055d5de39dafe185d029e8dd992f",
  "closure_digest": "81a23a36e08f51a804d79e0e65abc1d041e4957370d9f5da3a47931d3b93f8e2",
  "status": "unknown",
  "coverage": { "status": "complete" },
  "summary": {
    "total": 7,
    "required": 5,
    "verified": 0,
    "required_open": 5,
    "by_status": ["…"]
  },
  "reports": {
    "missing_owner_obligation_ids": [
      "obl.fn.deobfuscate",
      "…",
      "obl.secret.runtime"
    ],
    "missing_verifier_obligation_ids": [],
    "contradicted_obligation_ids": [],
    "residual_unknown_ids": [
      "unk_38dad07975fda4dea4b77da74c483a063ae1fab7cd31ca9daefe351019b8facd"
    ]
  }
}
```

#### Obligation fields

Reviewed (input) obligations carry the fields below up to `required_next_evidence`, plus `disposition` and `review_evidence_ids`. Output obligations drop those two and add `origin`, `authority_references`, `source_state`, `observed_cases`, `binding`, `status`, and `diagnostics`.

| Field                                  | Meaning                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `obligation_id` / `obligation_version` | Stable ID and version of the claim                                                                                                                                                                                                                                                                                       |
| `title`                                | Human-readable description                                                                                                                                                                                                                                                                                               |
| `application_layer`                    | `cli`, `protocol`, `electron`, `persistence`, `process`, `runtime`, `packaging`, `native-abi`, `application`, `other`                                                                                                                                                                                                    |
| `family`                               | Functional family (`argument-parsing`, `request-response`, `control-flow`, …)                                                                                                                                                                                                                                            |
| `target`                               | `artifact_sha256`, `application_node_id` (`jag_node_…` or `null`), `semantic_node_id` (`jsrg_node_…` or `null`), `location`; all four required                                                                                                                                                                           |
| `required`                             | Whether the claim must be satisfied for this ledger's goal                                                                                                                                                                                                                                                               |
| `required_case_kinds`                  | One or more of `positive`, `negative`, `malformed`, `cancellation`, `teardown`                                                                                                                                                                                                                                           |
| `required_original_authority`          | Authority of the original observation: `static`, `runtime`, `process`, `external`                                                                                                                                                                                                                                        |
| `required_fixture_authority`           | Authority required for fixtures: `unit`, `integration`, `protocol`, `renderer`, `packaged-process`, `native-abi`, `live-observation`, `external`                                                                                                                                                                         |
| `required_verifier_authority`          | Authority required of the verifier (same values as fixture authority)                                                                                                                                                                                                                                                    |
| `requires_parser_type`                 | If true, a parser, schema, or domain type must be supplied                                                                                                                                                                                                                                                               |
| `dependency_obligation_ids`            | Obligations this one depends on                                                                                                                                                                                                                                                                                          |
| `residual_unknown_ids`                 | Linked open residual unknowns                                                                                                                                                                                                                                                                                            |
| `unavailable_authority`                | Authorities that can't be supplied                                                                                                                                                                                                                                                                                       |
| `required_next_evidence`               | Suggested evidence needed to proceed                                                                                                                                                                                                                                                                                     |
| `disposition`                          | **Input only.** `active`, `blocked`, `out-of-scope`                                                                                                                                                                                                                                                                      |
| `review_evidence_ids`                  | **Input only.** Evidence reviewed for this obligation (at least one)                                                                                                                                                                                                                                                     |
| `origin`                               | **Output.** `generated` or `reviewed`                                                                                                                                                                                                                                                                                    |
| `authority_references`                 | **Output.** `[{evidence_id, authority, state, location}]`; `state` is `candidate`, `observed`, `reviewed`, or `unknown`                                                                                                                                                                                                  |
| `source_state`                         | **Output.** `candidate`, `observed`, `reviewed`, `unknown`                                                                                                                                                                                                                                                               |
| `observed_cases`                       | **Output.** `[{kind, evidence_id, location}]` original cases found                                                                                                                                                                                                                                                       |
| `binding`                              | **Output.** The manifest binding that owns the obligation, or `null`                                                                                                                                                                                                                                                     |
| `status`                               | **Output.** Derived status (see [Closure semantics](#closure-semantics))                                                                                                                                                                                                                                                 |
| `diagnostics`                          | **Output.** `[{code, detail}]`, e.g. `missing-owner`, `missing-original-case`, `missing-verifier`, `weak-verifier-authority`, `verifier-failed`, `static-only`, `contradiction`, `residual-unknown`, `dependency-missing`, `dependency-open`, `unavailable-authority`, `blocked`, `out-of-scope`, `duplicate-definition` |

#### Manifest

- **`bindings`**: `[{obligation_id, owner {module_path, symbol, …}, parser_type (or null), original_cases [{kind, evidence_id, location}], fixtures [{…, case_kind, authority, evidence_ids}], verifier (or null) {authority, status pass/fail/unknown/unsupported/skipped, result_evidence_id, enumerated_obligation_ids, nondeterminism {mode, specification}}}]` (simplified view).
- **`contradictions`**: `[{obligation_id, evidence_ids (at least 2)}]`; a contradiction makes the obligation `contradicted`.

See [Closure semantics](#closure-semantics) for dispositions, statuses, and the rules that make an obligation `verified`.

#### Design invariants

- Static Application Graph facts create _candidate_ obligations; they don't prove runtime or process behavior.
- Every referenced `evidence_id` must exist in the input bundle.
- Authority must be comparable: a unit test with `packaged-process` authority can't close a runtime obligation, and static-only evidence can't close a process claim.
- The ledger is conservative: absence of Evidence never claims closure.
- Export/import validates canonical form and rejects tampering or conflicting duplicates.

### Closure semantics

An obligation closes (counts as verified) only when a single manifest binding supplies every required element with comparable authority. The ledger is conservative by design: static Application Graph facts can generate candidate obligations, but they don't prove runtime or process behavior.

#### What must be present to close an obligation

All of the following must appear in the manifest and exist in the Evidence bundle:

1. **Unique owner binding**: module path, symbol, and SHA-256 of the owner.
2. **Parser / schema / domain type**: required only when `requires_parser_type` is true.
3. **Original cases**: authenticated Evidence (`evidence_id`) for every value in `required_case_kinds` (positive, negative, malformed, cancellation, …), with authority comparable to `required_original_authority`.
4. **Fixtures**: one per required case kind, each with its own `fixture_id`, `case_kind`, matching authority, and supporting Evidence IDs.
5. **Passing verifier**: status `"pass"`, enumerates the obligation ID, authority matches `required_verifier_authority`, and `result_evidence_id` exists in the bundle. Nondeterminism must be declared when present.

If any item is missing, contradictory, or under-authorized, the obligation does not reach `verified`; its status and `diagnostics` say why.

**In practice (6.7.0 beta):** REA does not generate the reviewed obligation list or the manifest bindings. To reach `verified` you must hand-write the obligations and, for each one, a binding with the owning module, the test fixtures, and a verifier result whose Evidence is in the bundle. With an empty manifest every obligation stays `unowned` (or `blocked` / `out-of-scope` / `unknown`), as in a 6.7.0 run against a small C test program.

#### What prevents closure

- Residual unknowns listed in `residual_unknown_ids`
- Contradictions recorded in the manifest
- Duplicate owners or definitions
- Missing dependencies
- Unavailable authority
- An explicit `blocked` or `out-of-scope` input disposition

Marking an obligation `blocked` or `out-of-scope` records the decision but never counts the claim as verified.

#### Input dispositions

Set by you on each reviewed obligation (`disposition`):

| Disposition    | Meaning                                                     |
| -------------- | ----------------------------------------------------------- |
| `active`       | Still in play; REA evaluates it against the manifest        |
| `blocked`      | Required in principle, but a concrete gap prevents progress |
| `out-of-scope` | Deliberately excluded from this ledger's goal               |

#### Output statuses

Derived by REA for every obligation (`status`). The evaluator checks in this order and takes the first match (source: `obligationStatus` in `dist/application/ReconstructionObligationLedgerEvaluation.js`):

| Order | Status          | When                                                                                                                                                        | Counts as verified? |
| ----- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 1     | `out-of-scope`  | `out-of-scope` diagnostic (from the input disposition)                                                                                                      | No                  |
| 2     | `blocked`       | `blocked` diagnostic (from the input disposition). A missing or open dependency also turns any result except `contradicted` / `out-of-scope` into `blocked` | No                  |
| 3     | `contradicted`  | A manifest contradiction                                                                                                                                    | No                  |
| 4     | `unknown`       | A linked residual unknown, unavailable authority, or a duplicate definition                                                                                 | No                  |
| 5     | `unowned`       | No manifest binding                                                                                                                                         | No                  |
| 6     | `verified`      | A binding exists and there are no diagnostics                                                                                                               | Yes                 |
| 7     | `implemented`   | A binding exists but diagnostics remain (e.g. missing verifier)                                                                                             | No                  |
| —     | `characterized` | In the schema enum, but the 6.7.0 evaluator never assigns it                                                                                                | No                  |

There is no `closed` status: the closed state is `verified`.

#### Ledger status

The whole ledger gets one `status`, checked top to bottom (source: `reconstructionObligationLedgerStatus`):

| Status    | When                                                                                        |
| --------- | ------------------------------------------------------------------------------------------- |
| `unknown` | No obligations (checked first)                                                              |
| `failed`  | A required, non-verified obligation is `contradicted` or has a `verifier-failed` diagnostic |
| `unknown` | Otherwise, any `limitations`, or a required open obligation with status `unknown`           |
| `open`    | Required obligations remain non-verified, none of the above                                 |
| `ready`   | Every required obligation is `verified`                                                     |

`failed` exists only at ledger level; no individual obligation is ever `failed`.

#### Authority rules

Authority must be comparable: a unit test with `packaged-process` authority can't close a runtime obligation, and static-only evidence can't close a process or runtime claim. The verifier's result Evidence must be in the input bundle. Absence of Evidence never silently becomes closure.

#### Ledger identity

The full result (every obligation, its status and diagnostics, residual-unknown links, ownership and dependency graphs, Evidence references, and limitations) is identified by `ledger_id` (`rol_…`) + `closure_digest`. The same bundle, reviewed obligations, and manifest always produce the same digest (confirmed by a rerun); changing any disposition, residual unknown, or Evidence link changes it.

`verified` is an explicit, auditable proof that the manifest supplied a unique owner, the required fixtures, and a passing verifier of comparable authority. Everything else stays visible and non-verified in the ledger.

### Blocked vs. out-of-scope

Both are explicit input dispositions on a reviewed obligation, and REA carries them through as output statuses of the same name. Neither counts as verified.

| Disposition      | Meaning                                                                                                                                                                                                      | Effect on the ledger                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| **blocked**      | A concrete obstacle stops progress (missing authority, unresolved residual unknown, missing dependency, unavailable environment, contradiction). The claim is still required but can't reach `verified` yet. | Recorded so the gap is visible. Not verified.       |
| **out-of-scope** | Deliberately excluded from this reconstruction; the ledger isn't trying to prove it.                                                                                                                         | Recorded so the boundary is explicit. Not verified. |

Use **blocked** when you still care about the claim and would reopen it once the blocker is gone. Use **out-of-scope** when the claim is outside this investigation's goals. Either way the disposition is kept, residual unknowns stay linked, and the claim is never silently treated as proven.

#### Examples: blocked vs. out-of-scope

**Blocked.** Obligation: "Recover the exact target of the indirect call at 0x100004a48 and prove the behavior matches the original binary." Static decompilation left the indirect call unresolved, and runtime capture isn't available (no matching device or emulator, or no authority for process observation). An open `unk_…` is listed in `residual_unknown_ids`. The claim is still required, but missing evidence or authority stops it.

**Out-of-scope.** Obligation: "Reconstruct and verify the analytics/telemetry upload path and its network payloads." The goal is only to understand and reimplement the core local search feature, so telemetry is deliberately excluded. This isn't a temporary blocker; it's outside the declared scope.

Both are kept in the ledger, and neither counts as verified.

##### Example: a blocked obligation (JSON)

Illustrative reviewed (input) obligation (placeholder hashes and IDs; enum values match the 6.7.0 schema). The claim is still required, but an unresolved indirect call and missing replay authority stop it:

```json
{
  "obligation_id": "native.controlflow.indirect_call_0x100004a48",
  "obligation_version": 2,
  "title": "Resolve the target of the indirect call at 0x100004a48 and prove the behavior matches the original binary",
  "application_layer": "native-abi",
  "family": "control-flow",
  "target": {
    "artifact_sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "application_node_id": null,
    "semantic_node_id": null,
    "location": "0x100004a48"
  },
  "required": true,
  "required_case_kinds": ["positive", "negative"],
  "required_original_authority": "static",
  "required_fixture_authority": "native-abi",
  "required_verifier_authority": "native-abi",
  "requires_parser_type": false,
  "dependency_obligation_ids": [],
  "residual_unknown_ids": [
    "unk_deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678"
  ],
  "unavailable_authority": ["controlled-replay"],
  "required_next_evidence": [
    "Runtime capture or cross-reference analysis that uniquely identifies the call target at 0x100004a48 with comparable authority"
  ],
  "disposition": "blocked",
  "review_evidence_ids": [
    "ev_a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456"
  ]
}
```

- `disposition: "blocked"` means still required but stopped by a concrete obstacle; the output `status` is `blocked`, never verified.
- `required: true` means closing it is necessary for the current goal.
- `residual_unknown_ids` keeps the call-target question linked and versioned.
- `unavailable_authority` and `required_next_evidence` say exactly what's missing.
- `review_evidence_ids` keeps the decompilation Evidence that left the call unresolved.
- It feeds `ledger_id` + `closure_digest`; changing the disposition, removing the unknown, or dropping the obligation changes the digest.

| Field                    | Blocked                              | Out-of-scope                                  |
| ------------------------ | ------------------------------------ | --------------------------------------------- |
| `disposition`            | `"blocked"`                          | `"out-of-scope"`                              |
| `required`               | `true`                               | `false`                                       |
| `required_next_evidence` | Non-empty (what's needed to proceed) | Empty                                         |
| Intent                   | Still needed; stopped by a gap       | Deliberately excluded from this ledger's goal |

Both are retained in the ledger and neither counts as verified.

##### Example: an out-of-scope obligation (JSON)

Illustrative reviewed (input) obligation (placeholder hashes and IDs; enum values match the 6.7.0 schema) for a claim excluded from a local-search reconstruction:

```json
{
  "obligation_id": "telemetry.analytics.upload",
  "obligation_version": 1,
  "title": "Reconstruct and verify the analytics/telemetry upload path and network payloads",
  "application_layer": "electron",
  "family": "network",
  "target": {
    "artifact_sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "application_node_id": "jag_node_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "semantic_node_id": null,
    "location": "analytics upload handler"
  },
  "required": false,
  "required_case_kinds": ["positive", "negative"],
  "required_original_authority": "runtime",
  "required_fixture_authority": "renderer",
  "required_verifier_authority": "renderer",
  "requires_parser_type": true,
  "dependency_obligation_ids": [],
  "residual_unknown_ids": [
    "unk_aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"
  ],
  "unavailable_authority": ["runtime"],
  "required_next_evidence": [],
  "disposition": "out-of-scope",
  "review_evidence_ids": [
    "ev_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  ]
}
```

- `disposition: "out-of-scope"` excludes the claim from this investigation; it never counts as verified.
- `required: false` means it isn't needed to close the current goal.
- `residual_unknown_ids` keeps noted open questions linked.
- `review_evidence_ids` keeps the Evidence examined when the scope decision was made.
- It still feeds `ledger_id` + `closure_digest`; removing it or changing the disposition changes the digest.

##### Real output: a blocked obligation

What REA returned for a reviewed obligation submitted with `"disposition": "blocked"` (from a 6.7.0 run against a small C test program, trimmed):

```json
{
  "obligation_id": "obl.secret.runtime",
  "origin": "reviewed",
  "source_state": "reviewed",
  "authority_references": [
    {
      "evidence_id": "ev_b2ff5a17…",
      "authority": "shipped-artifact",
      "state": "candidate",
      "location": "/evidence/ev_b2ff5a17…"
    }
  ],
  "observed_cases": [],
  "unavailable_authority": [
    "runtime analysis not sandboxed; dynamic tooling disallowed"
  ],
  "binding": null,
  "status": "blocked",
  "diagnostics": [
    {
      "code": "blocked",
      "detail": "Reviewed disposition marks this obligation blocked."
    },
    {
      "code": "missing-original-case",
      "detail": "Original positive behavior has not been observed."
    },
    {
      "code": "missing-owner",
      "detail": "No reconstruction manifest binding owns this obligation."
    },
    {
      "code": "unavailable-authority",
      "detail": "runtime analysis not sandboxed; dynamic tooling disallowed"
    }
  ]
}
```

**Blocked contrast.** A blocked version would usually have `"disposition": "blocked"`, `"required": true`, and a non-empty `required_next_evidence` describing the missing authority or capture. An empty `required_next_evidence` on an out-of-scope item records that no further evidence is being sought for this ledger.

### Audit trail requirements

The ledger is built so the result can be audited without trusting the narrative.

- **Content-addressed identity.** Each Evidence record has a stable `evidence_id` (`ev_` + SHA-256 of the canonical semantic projection). The ledger's `ledger_id` + `closure_digest` cover the complete result: obligations, summaries, ownership and dependency graphs, Evidence links, and limitations.
- **Immutable Evidence with provenance.** Each record keeps the artifact digest, provider identity and version, operation, parameters, confidence, authority, environment, limitations, and typed locations. Import recomputes IDs and rejects tampering or conflicting duplicates.
- **Explicit residual unknowns.** Open questions are first-class `unk_` records with revision history and linked supporting and contradicting Evidence. Absence of evidence stays an unknown, never a negative fact.
- **Disposition is never silent.** `blocked` and `out-of-scope` are recorded explicitly and don't count as verified. Contradictions, missing dependencies, insufficient authority, or residual unknowns keep an obligation short of `verified` (as `contradicted`, `blocked`, or `unknown`), and a required contradicted obligation makes the whole ledger `failed`.
- **Auditable manifest bindings.** Closure needs a unique owner, the required parser, schema, or domain type (when applicable), original-case Evidence for every required case kind, matching fixtures, and a passing verifier with authority comparable to the original observation and its result Evidence in the bundle. Every referenced `evidence_id` must exist.
- **Export, import, and compare.** Bundles export in canonical form, re-import with validation, and can be compared. Snapshots keep exact prior results when target bytes, operation, and parameters match.

Together these make the ledger reconstructible and tamper-evident. The same Evidence and manifest re-derive the same `closure_digest`, and you can see which claims reached `verified` and why, and which were deliberately left blocked or out-of-scope.

#### Audit trail for blocked and out-of-scope obligations

Both are first-class input dispositions and output statuses. The ledger never drops them, so the result stays reconstructible and the decision not to treat them as verified is explicit.

**What the ledger records for each one**

- The obligation itself (`obligation_id`, version, target, required case kinds, residual-unknown links)
- The output `status` (`blocked` or `out-of-scope`) and its `diagnostics`
- Linked residual unknowns (`residual_unknown_ids`)
- Related Evidence IDs (supporting, contradicting, or review Evidence)
- The fact that the disposition does not count as verified

These fields feed the ledger's `ledger_id` + `closure_digest`. Changing a disposition (for example `active` to `out-of-scope`), removing an obligation, or altering its residual unknowns changes the digest.

| Requirement                  | Applies?                 | What it means                                                                                                                       |
| ---------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Content-addressed Evidence   | Yes                      | Evidence cited by the obligation or its unknowns has a stable `ev_…` ID from the canonical semantic projection.                     |
| Immutable provenance         | Yes                      | Artifact digest, provider, operation, parameters, confidence, authority, limitations, and locations stay attached.                  |
| Residual unknowns as records | Yes (especially blocked) | Versioned `unk_…` records with supporting and contradicting Evidence IDs; never deleted when an obligation is marked blocked.       |
| Explicit disposition         | Yes                      | Carried into the output `status` with a matching diagnostic; never treated as verified.                                             |
| Ledger-level identity        | Yes                      | `closure_digest` covers all obligations, statuses, unknown links, and Evidence references.                                          |
| Export / import validation   | Yes                      | Canonical export includes dispositions; re-import recomputes IDs and rejects tampering or conflicts.                                |
| No silent closure            | Yes                      | Unknowns, contradictions, missing authority, or a blocked or out-of-scope disposition keep the obligation from reaching `verified`. |

In the trail, **blocked** shows a claim that's still required but stopped by a concrete gap, with its unknowns still linked. **Out-of-scope** shows a deliberate exclusion: it's kept so the boundary is visible and so a later reader can tell the exclusion was intentional, not an oversight or a missing proof. Per the official docs, marking a claim blocked or out-of-scope "records the disposition but does not silently count it as verified."

For concrete blocked and out-of-scope records, see the examples in [Blocked vs. out-of-scope](#blocked-vs-out-of-scope).

## Architecture patterns

A few consistent patterns run through REA's Evidence model, MCP/CLI surface, and session handling.

### 1. Content-addressed, immutable Evidence

Each observation is an immutable record whose `evidence_id` (`ev_…`) is a SHA-256 of the canonical semantic projection. Local paths and the ID itself don't affect identity; the same inputs always give the same ID, and import recomputes it and rejects tampering or conflicting duplicates. This gives deduplication and exact reuse (snapshots, comparisons), tamper-evident records, and stable citations. Residual unknowns follow a similar revisioned pattern (`unk_…` IDs with digest chains).

### 2. Provider-neutral domain with adapter boundaries

Public tool names and Evidence schemas are provider-neutral. Ghidra, Hopper, IDA, JADX, the JS analyzer, and others are adapters producing the same Evidence shape. Domain and application layers hold no provider-specific code, and dependencies flow inward (domain, adapters, workflows, CLI/MCP). The JavaScript Application Graph is a pure, side-effect-free domain model that validates facts and derives identities without I/O.

### 3. Session-owned Evidence ledger

Each MCP connection (or CLI process) owns an in-memory `EvidenceLedger` of immutable records and unknown revisions. Tools return complete Evidence inline and retain it in the session; `retained-evidence` references are scoped to the connection. Export produces a portable Evidence Bundle; import validates and merges atomically. Agents can cite earlier results without re-running them, and full export still supports offline or cross-session use.

### 4. Fail-closed and explicit unknowns

Missing coverage is recorded as unknown, not absence. Limitations are first-class fields, and residual unknowns stay linked instead of being dropped. The contribution rule is fail-closed: don't integrate a capability while material scope, authority, side-effect, or verification questions remain unresolved. Unresolved identity or applicability stays unknown rather than treated as absent or aligned.

### 5. Conservative derived ledgers

The obligation ledger is a deterministic projection over an Evidence Bundle + manifest. Static graph facts create candidates only; reaching `verified` needs a unique owner, required fixtures, and a passing verifier of comparable authority (see [Closure semantics](#closure-semantics) for input dispositions, output statuses, and ledger status). The result is identified by `ledger_id` (`rol_…`) + `closure_digest`.

### 6. Shared CLI / MCP contracts with agent-aware delivery

CLI and MCP share workflows and Evidence contracts. MCP returns complete Evidence inline, with paging and summaries for large results, and retains it in the session. Delivery favors summaries and retained references to save agent tokens while keeping full Evidence reachable. Tools are composable primitives rather than rigid call sequences.

### 7. Ownership and lifecycle invariants

Resources (provider processes, temporary workspaces, captures) have clear owners. A failed cleanup keeps ownership for retry instead of assuming success. Proof of ownership is kept separate from validity or readiness. Lifecycle changes must preserve identity and handle cancellation, late handshakes, and mixed child outcomes.

### Pattern summary

| Pattern                                | Purpose                                              | Example                                  |
| -------------------------------------- | ---------------------------------------------------- | ---------------------------------------- |
| Content-addressed immutability         | Stable, tamper-evident identity                      | `ev_…` / `unk_…` IDs, `closure_digest`   |
| Provider-neutral domain                | Same contracts across tools                          | Evidence schema, Application Graph       |
| Session ledger + portable bundle       | Local reuse plus exportable audit trail              | `EvidenceLedger`, evidence import/export |
| Fail-closed / explicit unknowns        | No silent assumptions                                | Residual unknowns, limitations arrays    |
| Conservative derived projections       | Auditable higher-level claims                        | Obligation ledger                        |
| Shared contracts, agent-aware delivery | CLI and MCP equivalent; summaries plus full Evidence | MCP inline Evidence + paging             |
| Ownership and lifecycle invariants     | Safe cleanup and retry                               | Provider processes, workspaces, captures |

The patterns reinforce each other: content-addressed Evidence makes both the session ledger and the obligation ledger reproducible and auditable, and the fail-closed rule keeps incomplete knowledge visible instead of filled in.

### Related patterns

REA's append-only, content-addressed records resemble **event sourcing** (Evidence and unknown revisions as the stream, the obligation ledger as a projection), and its tool surface loosely mirrors **CQRS** (analysis tools append records; summaries, views, and ledgers are read-side projections). Background on event sourcing, CQRS, command handlers, the mediator pattern, the observer pattern, and the factory pattern is in [architecture patterns](./architecture-patterns.md).

## Design implications

Immutable Evidence, residual unknowns, and a conservative obligation ledger have practical consequences.

### For agents and users

- **Fewer silent hallucinations.** An agent can't treat missing information as a negative fact or invent a confident answer; open questions stay as residual unknowns and must be cited or left explicit.
- **Traceable conclusions.** Every claim walks back to specific `ev_…` records or to an explicit unknown, so findings are easy to audit or challenge.
- **Scoped work is visible.** `out-of-scope` and `blocked` are recorded and never count as verified, so the investigation's boundary stays clear instead of disappearing into a narrative.

### For reconstruction and verification

- **Closure is expensive on purpose.** An obligation reaches `verified` only with a unique owner, required fixtures, and a passing verifier of comparable authority; static graphs alone can't prove runtime behavior. That raises the bar for "we reconstructed it."
- **Partial progress stays useful.** You can ship or reason about a reconstruction while some obligations stay blocked or out-of-scope; the ledger shows exactly what's left open.
- **Reproducible verdicts.** The same bundle + manifest always yields the same `closure_digest`, so later readers or tools can re-derive the result without trusting the original narrative.

### For tooling and workflow

- **Evidence is reusable.** Content-addressed, portable records feed comparisons, snapshots, unknown updates, and ledgers without re-running analysis.
- **Unknowns become work items.** Residual unknowns can be listed, filtered, and resolved later, turning "I don't know" into something trackable.
- **Authority is explicit.** Observed, derived, and inferred results are distinguished, and closure requires comparable authority, so a unit test isn't mistaken for proof of runtime behavior.

### Trade-offs

- **More ceremony.** Useful observations must be captured as Evidence and open questions recorded as unknowns, which makes exploratory work feel heavier.
- **Large artifacts.** Full Evidence for real applications can be big; the design assumes paging, summaries, and retained references rather than loading everything at once.
- **Conservative bias.** The ledger would rather leave claims `unowned`, `unknown`, or `implemented` (and the ledger `open`, `unknown`, or `failed`) than declare them `verified`: safer for auditability, slower when you want a quick "good enough" reconstruction.

Overall, the design favors auditability and honesty over speed of assertion. It's harder to over-claim, and easier for a later reader to see what was observed, what remains unknown, and which claims were actually proven.

## Version history

| Version | Notable additions                                                                                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 4.1     | Android APK analysis (headless JADX), firmware (Binwalk/Unblob), stronger IDA support                                                                                                      |
| 5.0     | Better macOS bundle handling, Wakaru module recovery, browser/source-map improvements                                                                                                      |
| 6.0     | EVM bytecode, ELF layout + crash analysis, LLDB tracing, wider Ghidra Windows support                                                                                                      |
| 6.1–6.4 | Android device/ADB workflows, JEB integration, better large-analysis handling, more native architectures                                                                                   |
| 6.5     | Improved JS source selection & cross-bundle recovery, retained Evidence paging, SQLite snapshots, packet/signal/HAR/QUIC analysis, WASM, Rust metadata, Electron fuses, more agent clients |

**Documented against rea-agents 6.7.0** (latest on npm, 2026-10-18; 153 CLI commands, 207 MCP tools).

#### Beta test findings (Oct 2026)

A static-only beta against a known C test program (debug and stripped builds; Ghidra 12.1.4, Rizin 0.9.1, Node 22.23.3). Key results that shaped this guide:

- `ev_`, `unk_`, `ledger_id`, and `closure_digest` were identical on rerun.
- `analyze` and `function` opened no residual unknowns on their own; the one linked unknown was recorded explicitly.
- Obligation statuses and ledger statuses are separate sets; there is no `closed` status and `failed` is ledger-level only.
- With no manifest bindings, every active obligation came back `unowned`; reaching `verified` needs hand-written obligations and bindings.
- The XOR-obfuscated string was not recovered as plaintext; stripped-build function names were not recovered.
