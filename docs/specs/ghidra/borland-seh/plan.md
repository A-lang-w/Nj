# Implementation plan

## Review revision contract

Before extending a function across a non-fallthrough handler jump, require a
caller-supplied or imported Borland RTL symbol;
an arbitrary executable destination is insufficient. Unknown layouts retain
an explicit omission. Keep SEH provenance on procedure-reference observations,
merge omission coverage with existing computed-call diagnostics at the Java
producer, and require verified empty process lineage before verifier success.
Integrate these facts into main's current boundary-observation/source manifest
contracts and cover a shared-handler jump followed by unrelated instructions.

1. Add a Ghidra-owned producer that reads decoded instruction encodings and
   tracks exact adjacent zero-offset registration patterns. Use Ghidra's
   disassembler with a restriction set containing only unowned gaps; disable
   automatic code analysis for that command.
2. Traverse handler entry and the continuation after its RTL jump veneer.
   Add decoded reachable instructions only, stop at original body/other owners,
   and require a return to the original body or a recognized flow terminator.
   Store per-function diagnostics, including unrecovered handler addresses.
3. Run the producer once before the bridge initializes its decompiler. Supply
   its diagnostics to every function observation; preserve the existing shape.
   Bind the changed semantics into the analysis profile.
4. Verify a self-owned PE32 fixture through real Ghidra, including negative
   registration and ownership cases. Run source/static/document checks.
5. If process-group verification races with an acknowledged JVM shutdown,
   wait for the retained child exit and retry full group verification once.
   Child exit alone never authorizes runtime deletion; incomplete group
   cleanup retains its supervisor and files for a later verified close.

## Executed validation

Review revision on upstream `1629266e3`, Node 24.18.0, Ghidra 12.1.4,
JDK 21 and darwin/arm64:

- 354 tests passed across function values, provider behavior, snapshot/MCP,
  client lifecycle, bridge-source ownership and packed-bridge suites.
- Real CLI/MCP and producer-probe verification passed, including rejecting an
  ordinary shared-handler jump followed by unrelated bytes, recovery with a
  supplied RTL identity, procedure-reference provenance, partial coverage with
  indirect-call diagnostics, immutable target and verified empty lineage.
- Static checks and docs checks passed. The old Greek README drift (#3022)
  is resolved in current main.
- Full package verification passed, including installation/update, CLI/MCP,
  setup/uninstall and verified empty process lineage.
- The public executable reproduction recorded before review used the previous
  permissive jump heuristic. It has not been rerun with the current RTL-identity
  gate and does not establish the current branch's public-target recovery.
  Windows-host execution and full public-target coverage remain unverified.
- No controlled speed, live-model token or process-family memory comparison was
  performed for this pass; no performance improvement is claimed.

## Follow-up review implementation

Use one analysis-wide recovery budget (16,384 instruction/work visits, 64 KiB
new instruction bytes, and 4,096 queued addresses), charged before disassembly
or enqueueing. Restrict each DisassembleCommand to the x86 maximum instruction
extent (15 bytes) and disable flow following. Exhaustion is an omission, not a
format limit. Re-read the entry instruction at the producing boundary after recovery.
Wrap containment in the existing value/limitations envelope and validate that
operation's envelope at the inventory boundary. Exercise budget exhaustion,
in-span independent RTL, initially cleared instructions, and positive/negative
containment through real Ghidra and CLI/MCP.

Follow-up validation on `ccc7da309`: 204 tests passed across function/inventory
values, client lifecycle, bridge-source ownership and inventory MCP. The real
Ghidra probe/CLI/MCP run passed the large NOP-gap budget omission without partial
body publication, in-span independent RTL, initially undecoded veneer provenance,
and positive/omitted containment provenance. Target SHA-256 remained unchanged;
runtime roots were empty and process lineage was positively verified empty.
Static and documentation checks passed. Windows-host and full public-binary
coverage remain unverified; no new performance improvement is claimed.

## Instruction-boundary review

Require exact decoded instruction starts before reusing either original-body or
newly recovered destinations; a jump into an immediate is an omission, not a
completed path. Admit a decoded terminal FlowType as a static terminator and
retain that provider classification as a caveat, without claiming runtime
non-return. Share one address-to-SEH-observation owner across containment,
instruction inspection and call-target resolution. Bind the new envelopes into
the cache profile and test the real producer's overlap/terminal controls.
Update the tar-listing test to consume the canonical bridge source manifest,
while retaining independent negative cases for missing entries and bytecode.

Latest instruction-boundary review: 122 focused regressions passed, including
LF/CRLF tar listings, missing required helper and forbidden bytecode. Static
and docs checks passed. Sequential real Ghidra 12.1.4 producer/CLI/MCP verification
passed exact instruction boundaries (including an already-owned registered
mid-instruction entry), terminal calls with static caveats, and instruction/
call-target provenance; target bytes were unchanged, runtime empty and process
lineage positively verified empty.

The full package verifier was attempted twice on this revision and did not
complete: first the packaged MCP startup probe exceeded its 5-second timeout;
then the update fixture failed with ERR_HTTP_HEADERS_SENT at
scripts/verify-package-update.mjs:29 during registry proxying. Package install
completed in the second run, but that does not establish the later update/MCP
checks. The previous review revision passed full package verification. The
fixture/network failure is a separate validation gap; this revision does not
claim a successful full-package run or a performance improvement.

## Speculative recovery and relationship provenance review

Track the exact newly disassembled code-unit set for each handler candidate.
On an omitted or cancelled traversal, clear only those new units and their
references with a non-cancelled cleanup monitor; preserve pre-existing listing
units and earlier successful candidates. Do not abort a nested Ghidra transaction:
its rollback also aborts the enclosing program transaction. Run reference analyzers
only after the traversal has passed every omission gate.

Use the shared address-to-observation owner for all returned match and incoming
reference source addresses. Carry deduplicated source-function observations on
callers, incoming procedure references and xrefs, with strict value/limitations
envelopes for xrefs, procedure_address and search_bytes. Preserve normalized
values and coverage fields, invalidate old observation profiles, and update
controlled fixtures. Verify rollback of non-entry speculative instructions and
references, retained pre-existing instructions, multi-owner search aggregation,
reverse-reference provenance and unrelated-query controls through real Ghidra/MCP.

Validation for review 5601920500: 238 tests passed across function/inventory
contracts, snapshot admission, MCP Evidence, client lifecycle and bridge-source
packaging. Both CI failures were stale v4 observation-profile expectations; the
updated snapshot test explicitly rejects the previous v5 semantics. Static and
documentation checks passed. The sequential real Ghidra 12.1.4/JDK 21 CLI/MCP
run passed omitted/cancelled speculative-unit cleanup, retained existing listing
and user references, preserved earlier successful recovery, procedure selection,
byte search, reverse callers/references/xrefs, incoming instruction/dossier
provenance and unrelated-query controls. Target SHA-256 remained unchanged;
runtime roots were empty and process lineage was positively verified empty.
Full-package verification was not rerun for this review; the recorded #6038
gap remains. Windows-host/public-binary coverage and performance comparisons
remain outside the verified scope.
