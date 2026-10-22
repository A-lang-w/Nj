# Reconstruction obligation ledgers

`build_reconstruction_obligation_ledger` turns authenticated Evidence records
into a deterministic list of reconstruction claims. The same workflow
is available as:

- MCP tool: `build_reconstruction_obligation_ledger`
- CLI command: `rea build-reconstruction-obligation-ledger`

The ledger is conservative by design. Static Application Graph facts create
candidate obligations; they do not prove runtime or process behavior. A required
obligation closes only when one manifest binding supplies a unique owner, any
required parser/schema/domain type, every required case fixture, and a passing
verifier whose authority is comparable to the original observation. The
verifier must enumerate the obligation ID and its result must be present in the
input Evidence bundle. Contradictions, duplicate definitions or owners,
residual unknowns, missing dependencies, and unavailable authority keep closure
open or failed.

## Complete CLI request

This empty request is useful for checking client integration. It is valid and
returns an `unknown` ledger with zero obligations; absence of source Evidence
never claims closure:

```sh
rea build-reconstruction-obligation-ledger \
  '{
    "evidence_bundle": {
      "artifacts": [],
      "providers": [],
      "environments": [],
      "scenarios": [],
      "captures": [],
      "unknowns": [],
      "records": []
    },
    "reviewed_obligations": [],
    "manifest": {
      "bindings": [],
      "contradictions": []
    }
  }' \
  --json
```

For a real investigation, export an Evidence bundle from the session and replace
the empty bundle. Application Graph and process capture records generate
conservative candidates automatically. Add reviewed obligations when a required
claim is not represented by those sources.

## Reviewed obligation examples

Each example below is a complete `reviewed_obligations` element. Replace the
sample Evidence ID with an authenticated review record already present in
`evidence_bundle.records`. Stable IDs and versions make changes reviewable.

### CLI parsing

```json
{
  "obligation_id": "cli.config.invalid-option",
  "obligation_version": 1,
  "title": "Reject an invalid configuration option with the supported CLI error",
  "application_layer": "cli",
  "family": "argument-parsing",
  "target": {
    "artifact_sha256": null,
    "application_node_id": null,
    "semantic_node_id": null,
    "location": "rea --unknown-option"
  },
  "required": true,
  "required_case_kinds": ["positive", "negative", "malformed"],
  "required_original_authority": "process",
  "required_fixture_authority": "packaged-process",
  "required_verifier_authority": "packaged-process",
  "requires_parser_type": true,
  "dependency_obligation_ids": [],
  "residual_unknown_ids": [],
  "unavailable_authority": [],
  "required_next_evidence": ["Capture the installed CLI for all three cases."],
  "disposition": "active",
  "review_evidence_ids": [
    "ev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  ]
}
```

### Protocol handler

```json
{
  "obligation_id": "protocol.rpc.cancel",
  "obligation_version": 1,
  "title": "Cancel an in-flight request and emit one terminal response",
  "application_layer": "protocol",
  "family": "request-response",
  "target": {
    "artifact_sha256": null,
    "application_node_id": null,
    "semantic_node_id": null,
    "location": "JSON-RPC request cancellation"
  },
  "required": true,
  "required_case_kinds": ["positive", "negative", "malformed", "cancellation"],
  "required_original_authority": "external",
  "required_fixture_authority": "protocol",
  "required_verifier_authority": "protocol",
  "requires_parser_type": true,
  "dependency_obligation_ids": [],
  "residual_unknown_ids": [],
  "unavailable_authority": [],
  "required_next_evidence": [
    "Record request, cancellation, and terminal response IDs."
  ],
  "disposition": "active",
  "review_evidence_ids": [
    "ev_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  ]
}
```

### Electron startup and background behavior

```json
{
  "obligation_id": "electron.background.startup",
  "obligation_version": 1,
  "title": "Start the background process before exposing the renderer bridge",
  "application_layer": "electron",
  "family": "startup",
  "target": {
    "artifact_sha256": null,
    "application_node_id": null,
    "semantic_node_id": null,
    "location": "main process startup"
  },
  "required": true,
  "required_case_kinds": ["positive", "negative", "teardown"],
  "required_original_authority": "runtime",
  "required_fixture_authority": "renderer",
  "required_verifier_authority": "renderer",
  "requires_parser_type": false,
  "dependency_obligation_ids": [],
  "residual_unknown_ids": [],
  "unavailable_authority": [],
  "required_next_evidence": [
    "Observe main/renderer ordering and application shutdown."
  ],
  "disposition": "active",
  "review_evidence_ids": [
    "ev_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  ]
}
```

### Persistence migration

```json
{
  "obligation_id": "persistence.profile.migrate-v2",
  "obligation_version": 1,
  "title": "Migrate a version-one profile without losing unknown fields",
  "application_layer": "persistence",
  "family": "migration",
  "target": {
    "artifact_sha256": null,
    "application_node_id": null,
    "semantic_node_id": null,
    "location": "profile schema v1 to v2"
  },
  "required": true,
  "required_case_kinds": ["positive", "negative", "malformed"],
  "required_original_authority": "runtime",
  "required_fixture_authority": "integration",
  "required_verifier_authority": "integration",
  "requires_parser_type": true,
  "dependency_obligation_ids": [],
  "residual_unknown_ids": [],
  "unavailable_authority": [],
  "required_next_evidence": [
    "Compare pre-migration and committed storage snapshots."
  ],
  "disposition": "active",
  "review_evidence_ids": [
    "ev_dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
  ]
}
```

### Native ABI

```json
{
  "obligation_id": "native-abi.helper.status",
  "obligation_version": 1,
  "title": "Preserve the helper status-code and output-buffer contract",
  "application_layer": "native-abi",
  "family": "ffi",
  "target": {
    "artifact_sha256": null,
    "application_node_id": null,
    "semantic_node_id": null,
    "location": "helper_status(const uint8_t *, size_t, uint8_t *, size_t *)"
  },
  "required": true,
  "required_case_kinds": ["positive", "negative", "malformed"],
  "required_original_authority": "process",
  "required_fixture_authority": "native-abi",
  "required_verifier_authority": "native-abi",
  "requires_parser_type": true,
  "dependency_obligation_ids": [],
  "residual_unknown_ids": [],
  "unavailable_authority": [],
  "required_next_evidence": [
    "Run the ABI harness against the shipped and reconstructed libraries."
  ],
  "disposition": "active",
  "review_evidence_ids": [
    "ev_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  ]
}
```

## Manifest and closure

A manifest binding names one owner and its exact implementation digest. Both
`original_cases` and the reconstruction fixture list must cover every
`required_case_kinds` value with authenticated, comparable Evidence.
`parser_type` is mandatory when `requires_parser_type` is true.

```json
{
  "obligation_id": "protocol.rpc.cancel",
  "owner": {
    "module_path": "src/protocol/requestRouter.ts",
    "symbol": "cancelRequest",
    "owner_sha256": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
  },
  "parser_type": {
    "parser": "parseCancelRequest",
    "schema": "cancelRequestSchema",
    "domain_type": "CancelRequest"
  },
  "original_cases": [
    {
      "kind": "positive",
      "evidence_id": "ev_6666666666666666666666666666666666666666666666666666666666666666",
      "location": "/captures/positive"
    },
    {
      "kind": "negative",
      "evidence_id": "ev_7777777777777777777777777777777777777777777777777777777777777777",
      "location": "/captures/negative"
    },
    {
      "kind": "malformed",
      "evidence_id": "ev_8888888888888888888888888888888888888888888888888888888888888888",
      "location": "/captures/malformed"
    },
    {
      "kind": "cancellation",
      "evidence_id": "ev_9999999999999999999999999999999999999999999999999999999999999999",
      "location": "/captures/cancellation"
    }
  ],
  "fixtures": [
    {
      "fixture_id": "rpc.cancel.positive",
      "case_kind": "positive",
      "authority": "protocol",
      "evidence_ids": [
        "ev_1111111111111111111111111111111111111111111111111111111111111111"
      ]
    },
    {
      "fixture_id": "rpc.cancel.negative",
      "case_kind": "negative",
      "authority": "protocol",
      "evidence_ids": [
        "ev_2222222222222222222222222222222222222222222222222222222222222222"
      ]
    },
    {
      "fixture_id": "rpc.cancel.malformed",
      "case_kind": "malformed",
      "authority": "protocol",
      "evidence_ids": [
        "ev_3333333333333333333333333333333333333333333333333333333333333333"
      ]
    },
    {
      "fixture_id": "rpc.cancel.cancellation",
      "case_kind": "cancellation",
      "authority": "protocol",
      "evidence_ids": [
        "ev_4444444444444444444444444444444444444444444444444444444444444444"
      ]
    }
  ],
  "verifier": {
    "verifier_id": "rpc.cancel.conformance",
    "claim_id": "protocol.rpc.cancel.v1",
    "command": "npm run test:protocol -- cancel",
    "authority": "protocol",
    "status": "pass",
    "result_evidence_id": "ev_5555555555555555555555555555555555555555555555555555555555555555",
    "enumerated_obligation_ids": ["protocol.rpc.cancel"],
    "implementation_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "nondeterminism": {
      "mode": "partial-order",
      "specification": "cancel precedes the single terminal response"
    },
    "negative_controls": [
      {
        "candidate": {
          "kind": "fixture",
          "fixture_id": "rpc.cancel.deliberate-defect"
        },
        "defect": "The candidate drops the cancellation response.",
        "status": "fail",
        "result_evidence_id": "ev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    ]
  }
}
```

Create one negative control by introducing one relevant defect in a separate
candidate copy. For a verifier that compares recorded outputs, this can be a
changed output fixture, as shown below. Run the **same verifier implementation**
against both candidates. Bind
that implementation's digest in `implementation_sha256`. The verifier's control
Evidence must carry that digest, the same verifier/claim/obligation IDs, the
candidate fixture ID or artifact SHA-256, and the stated `defect`. For a valid
failure it must report `passed: false` and `failure_kind: "behavior-mismatch"`;
an environment or execution failure is not evidence that the verifier detected
the defect. Every listed control must be resolved; an `unknown`, `unsupported`,
or `skipped` control keeps closure open even when another control fails. A
control whose authenticated Evidence records a pass reports `vacuous-verifier`
regardless of its declared status. REA checks that
the control candidate differs from the bound positive fixture or artifact.
Artifact controls also require a valid `candidate_sha256` in the passing
verifier Evidence; missing or malformed identity keeps closure open because
the candidate difference cannot be established.

For fixture controls, different names are not enough: `original.json` and
`corrupted.json` might contain identical bytes. Both verifier result Evidence
records must include `normalized_result.fixture_sha256s`, an object mapping
fixture IDs to lowercase SHA-256 content digests. The passing result must
identify every fixture in the binding and every additional fixture named in
its `fixture_ids`; the control result must identify the selected control fixture.
REA rejects a control whose digest matches any of those positive fixtures.
Missing or invalid digests also produce `invalid-control-candidate` and keep
closure open. Hash the exact consumed contents using the same representation
for both runs; do not hash filenames. Different digests establish changed
contents, not that the change is a relevant defect or that every bug is detected.

Migration: existing fixture-control manifests and stored ledgers still parse.
Re-record positive and control verifier Evidence with `fixture_sha256s`, then
update their Evidence references and rebuild. Historical readiness checks apply
the same requirement without rewriting the stored ledger.

Old manifests without controls still parse, but a freshly built ledger keeps
their obligations open with `unchallenged-verifier`. Previously exported ledger
Evidence retains its historical digest and status. When a readiness report
consumes a historical `ready` ledger, it applies the same verifier and control
Evidence assessment used when building a ledger. Missing authenticated failing
controls report `reconstruction-verifier-unchallenged`; invalid identities,
unresolved controls, and observed passing controls also block readiness. The
historical ledger itself is not changed. Rebuild from the manifest to reassess
the obligations. REA reads these records; it never runs the verifier.

All referenced Evidence IDs must exist in the bundle. A green unit test cannot
close a `packaged-process` obligation. A static-only source cannot close a
runtime or process claim. Marking a claim `blocked` or `out-of-scope` records the
disposition but does not silently count it as verified.

The `summary` counts obligations. `by_status`, `by_application_layer`, and
`by_source_state` place each obligation in exactly one bucket.
`by_evidence_authority` groups obligations by the Evidence `authority` of their
`authority_references`: an obligation counts once under each distinct authority
it cites, so those counts can exceed `total`. A reference's own `state` and the
obligation's `source_state` do not affect its authority bucket.

The tool returns every obligation inline. Its `ledger_id` and `closure_digest`
identify the complete result, including summaries, reports, ownership and
dependency graphs, Evidence links, and limitations.

For named boundaries with explicit verifier contracts and package-proof kinds,
see [reconstruction coverage](reconstruction-coverage.md).

## Challenge a verifier with a copied output fixture

A passing verifier result does not, by itself, demonstrate that the verifier
detects a wrong result. Before supplying that result to the ledger, a caller
can challenge the verifier with a **negative control**: a separate fixture with
one deliberate, relevant defect. This tests the verifier's sensitivity to that
defect; it is different from testing whether the reconstructed software rejects
an invalid input.

When a verifier consumes recorded outputs, the control can be a corrupted copy
of the reconstruction's output. There is no need to rebuild the reconstruction
for this comparison-level check. Keep the reference and original candidate
fixtures unchanged, and run the same verifier with the same reference and
settings against both the candidate and the control.

The following Python 3 example uses **synthetic fixtures**, shaped like the
result of reading a file after a container restart. It does not run Docker or
establish Docker behavior. Save it as `output_control.py` and run
`python3 output_control.py`; it uses only the standard library and writes no
files.

```python
from copy import deepcopy
import hashlib
import json


def fingerprint(value):
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def valid_file_result(value):
    if not isinstance(value, dict) or type(value.get("exists")) is not bool:
        return False
    if value["exists"]:
        return set(value) == {"exists", "content"} and isinstance(value["content"], str)
    return set(value) == {"exists"}


def verify(reference, candidate):
    if not valid_file_result(reference) or not valid_file_result(candidate):
        return {"status": "inconclusive", "reason": "invalid file-result fixture"}
    differences = [
        field for field in ("exists", "content")
        if reference.get(field) != candidate.get(field)
    ]
    return {"status": "fail" if differences else "pass", "differences": differences}


reference = {"exists": True, "content": "hello ordinary"}
candidate = {"exists": True, "content": "hello ordinary"}
original_fingerprints = (fingerprint(reference), fingerprint(candidate))

control = deepcopy(candidate)
control["content"] = "CORRUPTED"
baseline_result = verify(reference, candidate)
control_result = verify(reference, control)
invalid_result = verify(reference, {"exists": "not a boolean"})

if baseline_result != {"status": "pass", "differences": []}:
    raise RuntimeError("The baseline did not pass")
if control_result != {"status": "fail", "differences": ["content"]}:
    raise RuntimeError("The verifier did not detect the declared content defect")
if invalid_result["status"] != "inconclusive":
    raise RuntimeError("An invalid fixture was mistaken for defect detection")
if original_fingerprints != (fingerprint(reference), fingerprint(candidate)):
    raise RuntimeError("An original fixture was modified")
if fingerprint(control) == fingerprint(candidate):
    raise RuntimeError("The control did not change the candidate")

print(json.dumps({
    "baseline": {
        **baseline_result,
        "fixture_sha256s": {"after-restart": fingerprint(candidate)},
    },
    "control": {
        **control_result,
        "fixture_sha256s": {"after-restart.corrupted": fingerprint(control)},
    },
    "invalid_fixture": invalid_result,
    "reference_sha256": fingerprint(reference),
    "candidate_sha256": fingerprint(candidate),
    "control_sha256": fingerprint(control),
}, indent=2))
```

The baseline reports `pass`. The control reports `fail` specifically for
`content`, while the invalid fixture reports `inconclusive`. A crash, missing
input, or parser error must not be reported as detection of this content defect.
The script exits successfully only when all three expected outcomes and source
preservation checks hold; that exit code is the example's result, not the
individual control's verdict.

For real evidence, preserve the original output artifacts and give the control
its own identity. The example hashes a defined JSON serialization; if a verifier
consumes file bytes, fingerprint those exact bytes instead. Record the unchanged
verifier implementation, relevant settings, reference identity, candidate and
control identities, the targeted obligation, the deliberate defect, and both
observed results. An **expected** failure alone is not evidence of an **observed**
failure. If several controls are used, retain every outcome, including a control
that passes.

These checks apply to the comparison path that consumes the fixture. They do
not establish correct live execution, capture behavior, or complete reconstruction
equivalence. A verifier without a recorded-output interface needs a suitable
comparison boundary before this technique applies.

The JSON printed above is an example report, not a REA Evidence record, and its
fingerprints are not Evidence IDs. Capturing the example with
[process capture](process-capture.md) records the caller's run; it does not
automatically turn its output into a reconstruction proof. A caller must retain
the existing proof fields and provenance when recording verifier Evidence; the
`fixture_sha256s` maps supplement that proof. The manifest still selects the
control by fixture ID and result Evidence ID. See
[#4396](https://github.com/morluto/rea/issues/4396) for the control requirement.
