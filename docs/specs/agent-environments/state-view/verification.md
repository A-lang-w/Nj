# Verification

Verified base: bf1eeee9 (fetched main).

Executed on the implementation worktree after `npm ci` and `npm run
build:cached`; every check below ran as written in this pass, after the last
source change.

- `npm run check:fast`: typecheck and lint passed.
- `npm run format:check`: passed.
- `npx knip`: passed (exit 0).
- `npm run jscpd`: 3.40% duplicated lines over 3331 files, under the 3.5%
  gate; no clone involves a file this change adds.
- `npm run scan:todos`: passed.
- `npm run docs:check`: the built documentation checks and the README
  consistency conformance test (5 tests) passed.
- `npx vitest run --project domain --project services`: 338 files, 5830 tests
  passed, 5 pre-existing skips.
- `npm run test:focused --` the analysis-view MCP and CLI boundaries, the
  environment serve and export CLI boundaries, the environment serve MCP
  boundary, the compact input-schema MCP budget, the analysis-detail and
  advertised-input-example contracts and the qlog acceptance test: 9 files, 68
  tests passed, 1 pre-existing skip.

Real captures (outside the test suite): the built view ran through the
application service on 44 recorded captures (39 HAR, 5 browser scenario) with
all three template rules, in 7 to 46 ms each. 42 produced a state: 568 types,
2,213 entities, 2 documents, and 710 of 1,258 read tools state-backed (211
item, 497 list, 2 document views). The other read tools are recorded views:
306 not entities (singletons, configuration and computed views), 129 without
an identity field, 32 with unusable bodies (most are Nomad bodies with
integers beyond exact native conversion), 31 lists and 7 items that do not
reproduce, 26 without an initial recording, 12 query `POST`s and 5 documents
read under several queries. The two browser-scenario captures that did not
produce a state are refused inline with `resource_constraint`, as the
environment manifest view refuses them on unchanged main.

Not covered here: serving tool calls from the state, the AgentEnv data plane
and write effects, which are later increments.
