# Verification

Verified commit: e49361ca (this branch before this file, with #5600's head merged in). Executed on macOS with Node v22.23.1 (the repository pins 24.18.0 in `.nvmrc`, which was
not installed); the live applications ran on six disposable Linux VMs.

## Gates

- `npm run build:cached`, `npm run check:fast` (typecheck and lint), `npm run format:check`, `npx knip`,
  `npm run scan:todos`, `npm run docs:check`, `npm run verify:test-discovery` and `npm run mcp-catalog:check`: passed.
- `npm run jscpd`: 3.46% duplicated lines over 3603 files, under the 3.5% gate.
- `npx vitest run --project domain --project services`: 7484 passed, 5 pre-existing skips.
- `npm run test:prepare`, then `npm run test:focused --` the environment serve and export CLI boundaries, the serve
  and served-writes MCP boundaries, the analysis-view CLI and MCP boundaries, the compact input schema boundary and
  tool schema validity: 8 files, 78 passed.

New tests: `environmentStateSessions` (7 domain tests through the state view: a create repeated after a reset, a plan
built from a later session's call, a write one session confirms and another contradicts, initial state across
sessions, volatile and `fields-differ` across sessions, sessions that overlap in time, request validation) and one
`environmentState` service test (deriving with the manifest's sessions, refusing a state extracted without them).

## Six applications, three builds, held-out sessions

The six applications of the fidelity comparison (NetBox, Komga, Mealie, n8n, Shlink and self-hosted Sentry, same
images and seed scripts as their captures, on loopback) were each restored from one snapshot before every recording,
so every recording below started from the same state. A driver outside REA recorded:

- **Training:** a re-run of the original capture, then one session per write target (each collection the capture
  wrote, whether or not its environment served the write): the capture's reads before its first state write, a list,
  a create, a read of the created entity, a list, an update of it, a read, a delete, a read and a list.
- **Held-out**, with values the training never sent: per write target, two creates with changed free text, a read, a
  list, an update of the first created entity and of a seeded one, the reads after them, a delete of the second
  created entity and of a seeded one, the reads and a list after them; and a read of every seeded entity through its
  item tool.

Three environments were built per application with the published manifest's template rules, each on a local build of
this branch merged with the environment-compare and prefix-variance branches, and compared with every held-out
session by `environment-compare`:

- **one:** the capture re-run alone;
- **sessions:** the re-run and the training sessions in one HAR, with `session_starts`;
- **joined:** the same HAR read as one session.

| Application | Steps |   one | sessions | joined |
| ----------- | ----: | ----: | -------: | -----: |
| NetBox      |   273 | 98.9% |    98.9% |  98.9% |
| Komga       |   365 | 94.2% |    92.9% |  92.9% |
| Mealie      |   310 | 94.2% |    94.2% |  94.2% |
| n8n         |   143 | 88.8% |    89.5% |  89.5% |
| Shlink      |   137 | 92.0% |    92.0% |  92.0% |
| Sentry      |   226 | 40.7% |    51.3% |  40.7% |

Agreement ignoring order is the same as strict agreement except for Sentry: 77.4%, 88.1% and 77.4%.

The extra sessions did what they are for: they gave the write gate the reads the capture lacked. They did not raise
agreement by themselves, because what those reads showed was a modelling gap each time.

- **Mealie.** The capture creates a recipe whose response is only its slug and never reads it back, so all three
  recipe plans were `no-observation`, fixed by the first call. With the later-call rule, the training session's
  calls built them. The create is then contradicted by a recipe list that keeps its recorded members, the update is
  `unexplained-change`, and the delete is `unconfirmed`.
- **Komga.** The training session listed collections and read lists after creating one. That list keeps its recorded
  members, so after a create it answers 2 where Komga answers 3. The gate now withholds the collection create
  (`side-effect`) that the capture alone, which never listed after it, had served. The lower agreement is that
  create no longer being served.
- **Lists.** Komga's and Mealie's list views keep recorded members because a view's membership is decided per tool,
  and each tool has some filtered recordings (`library_id`, `search`). A line that only pages would need membership
  of its own to show created entities. Shlink's short-URL list is not a list view at all: its recordings vary in
  query, so it replays (`query-varies`).
- **Shlink.** An update sends `tags: ["scratch", "lighthouse-rota"]`, and Shlink stores and returns them sorted. The
  update's echo rule fails, which contradicts both the update and the create on the same read, in every build.
- **n8n.** A delete of a workflow that is not archived answers 400 in every session. Errors are not modelled, so the
  environment deletes.
- **Sentry.** The gain is recency, not modelling. Per-hour event buckets move with the current time while the
  environment's clock is frozen. The sessions build keeps the latest initial value of such a volatile field, from a
  session recorded 1 to 15 minutes before the held-out sessions. The capture re-run was recorded 83 to 97 minutes
  before them, across an hour boundary.
  The joined build reads those later sessions after the first session's writes, so they add nothing to its initial
  state.
- **NetBox.** Its site writes were already served from the capture, so the extra session changes nothing.

Reading the same recordings as one session never did better than sessions. It did worse for Sentry, whose later
sessions' reads followed the first session's writes and so added nothing to the initial state.

Two things found in the runs shaped the procedure:

- The joined n8n HAR (23.6 MB, with one 10.9 MB node-type catalogue per session) exceeded the HAR decoder's fixed
  192 MiB heap. The added sessions were recorded in full, but responses over the state's 256 KiB body limit were left
  out of the added sessions before joining (one record); the state reads no larger body.
- n8n's first training session replayed the capture's reads up to its first `create`, which included an unrelated
  tag write. A workflow list after that write showed `tags` unlike an item read before it, so the existing rule made
  every workflow view `fields-differ`. That session was re-recorded to stop at the first state write, where the other
  applications' training sessions already stopped.
  Held-out reads of seeded entities were re-recorded after all training sessions, so recording time favours no build.

The driver, its plans and the HARs are not part of this branch.
