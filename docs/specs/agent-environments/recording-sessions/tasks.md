# Tasks

- [x] Accept `session_starts` on the manifest and state view requests.
- [x] Order records by session and state the session count as a limitation.
- [x] Cut each session's initial recordings at its own first related write.
- [x] Classify changes across sessions as starting from the initial state.
- [x] Replay each session's writes from the initial state and gather every session's verdicts.
- [x] Build a plan from the first call that can build it, not only the first call.
- [x] Derive the served state with the manifest's sessions and refuse a state with others.
- [x] Add domain and service coverage.
- [x] Document recording sessions.
- [ ] Record training and held-out sessions on the six applications and measure the three builds.
- [ ] Run static, formatting, duplication, documentation and test gates.
