# Implementation plan

The branch builds on the write-plan branch.

1. **Request.** Add an optional, strictly ascending `session_starts` schema shared by the manifest and state view
   requests, and describe it in both and in the analysis-view tool contract.
2. **Timeline.** Pass the starts to the state accumulator, order records by session first, and add a limitation when
   there is more than one session.
3. **Initial state.** Map ordinals to sessions, cut each session's initial recordings at its own first related write
   (write cutoffs per session), and make the write-span check session-aware for change classification, membership
   and documents.
4. **Write gate.** Move a session's replay state into its own module and replay each session from the initial state,
   keeping the drafts, their confirmations and contradictions across sessions.
5. **Serving.** Derive the state with the manifest's `session_starts` and refuse a supplied state with others.
6. **Tests and documentation.** Domain and service tests as the spec's acceptance lists; document sessions in the
   environment-state and manifest sections and in the agent-environment guide.
7. **Measurement.** Record training and held-out sessions on the six applications and compare the three builds with
   `environment-compare`; record the results in `verification.md`.
