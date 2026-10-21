# Implementation plan

## Review revision contract

Wait for the canonical server's tracked handler to finish after each client
outcome, including timeout/cancellation, before dispatching the next call.
Abort blocked output writes without skipping session cleanup or attempting a
second write to the blocked destination. Resolve global flags before command
selection, validate snapshot/result destinations before dispatch, preserve
typed filesystem setup errors, and apply the canonical JSON parser's heap
admission and immutable-input ownership rules to stdin. Regression controls
must establish handler-finalization and blocked-write phases with barriers.

1. Validate JSON call records, IDs and conflicting options at the CLI boundary.
2. Lazily compose one production session and MCP server. Connect an SDK client
   through InMemoryTransport, so canonical registration, parsing, execution,
   Evidence delivery and cancellation remain identical to MCP.
3. Await each call and output write before advancing. Keep only the current
   result. Use canonical JSON serialization with backpressure; file outputs use
   exclusive creation and safe filenames. Do not return a second CLI document.
4. In finally, settle SDK server work and close server, client, optional
   observation resources and BinarySession; project typed cleanup failures.
5. Cover compiled CLI file/stdin calls, shared native sessions with real Ghidra,
   errors, duplicate/path IDs, stop/continue, output collisions and cancellation.
   Measure equivalent multi-query sessions; distinguish synthetic timing from
   real-provider costs. Run static, discovery and documentation checks.

## Executed validation

Review revision on upstream `1629266e3`, Node 24.18.0 and darwin/arm64:

- 22 CLI/session, tool-coverage and transport-ordering tests passed, including
  a real blocked stdout pipe, delayed handler finalization after timeout,
  leading global flags, destination conflicts, typed setup errors and dense
  stdin rejected under a constrained heap.
- Static checks and docs checks passed; old Greek README drift #3022 is resolved.
- Full package verification passed, including installation/update, CLI/MCP,
  setup/uninstall and verified empty process lineage.
- Real Ghidra 12.1.4 verified equivalent normalized results, one open followed
  by three calls, a saved snapshot, immutable target and empty owned runtime.
- Three standalone imports took 26.503 seconds; batch took 8.736 seconds.
  User/system CPU was 38.32/3.57 seconds versus 13.44/1.23 seconds. Peak
  individual RSS was 1.28 GB versus 1.13 GB; process-family peak memory was
  not measured. Host-cache warming prevents a controlled speed comparison.
- Output-only token estimates were 6,501 versus 6,801 including batch-open and
  metadata. No live model/input-schema token measurement was performed.
- Native active-cancellation, other providers/OSes and snapshot replay remain
  outside this executed verification scope.
