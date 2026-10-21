# Verification

Verified commit: 87e94d12 (this branch before this file). Executed on macOS with Node v22.23.1 (the repository pins 24.18.0 in `.nvmrc`, which was
not installed); the probes were recorded earlier against the live applications on six disposable Linux VMs.

## Gates

- `npm run build:cached`, `npm run check:fast` (typecheck and lint), `npm run format:check`, `npx knip`,
  `npm run scan:todos`, `npm run docs:check`, `npm run verify:test-discovery` and `npm run mcp-catalog:check`: passed.
- `npm run jscpd`: 3.46% duplicated lines over 3601 files, under the 3.5% gate.
- `npx vitest run --project domain --project services`: 7479 passed, 5 pre-existing skips.
- `npm run test:prepare`, then `npm run test:focused --` the environment serve and export CLI boundaries, the serve
  and served-writes MCP boundaries, the analysis-view CLI and MCP boundaries, the compact input schema boundary and
  tool schema validity: 8 files, 78 passed.

New tests: two domain tests in `environmentStateWrites` (a tool with a whole line and a filtered line names the whole
one, with `numberOfElements` and `totalElements` as counters, and a create the whole line lists is confirmed; a tool
whose lines are all whole, or none, names none) and one serving test in `environmentStateWriteAnswer` (after a served
create, the whole line lists the created book with its counters, and the filtered line keeps its recorded member).

## Six published environments before and after

The six published environments of the fidelity comparison (NetBox, Komga, Mealie, n8n, Shlink, self-hosted Sentry),
each built from its original capture, were compared with `environment-compare` before and after this change. The
probes were recorded against each application restored from one snapshot: the fidelity comparison's capture re-run,
create/read/update/delete scenario and read of every seeded entity, and held-out sessions recorded later with values
no capture sent (two creates, updates and deletes of created and seeded entities, and the reads and lists after them).
Both builds merged the environment-compare and prefix-variance branches, which the comparison and the manifests need.

| Environment | Steps | Before | After | Ignoring order, before | After |
| ----------- | ----: | -----: | ----: | ---------------------: | ----: |
| NetBox      |   479 |  98.5% | 98.5% |                  98.5% | 98.5% |
| Komga       |   600 |  94.7% | 95.2% |                  94.7% | 95.5% |
| Mealie      |   449 |  94.0% | 94.0% |                  94.9% | 94.9% |
| n8n         |   278 |  71.6% | 71.6% |                  84.2% | 84.2% |
| Shlink      |   202 |  87.1% | 87.1% |                  90.1% | 90.1% |
| Sentry      |   372 |  24.5% | 24.5% |                  47.6% | 47.6% |

Komga is the one environment whose list tools have both kinds of line: `/api/v1/collections` lists every collection,
`?library_id=…` filters them. After the change the whole line lists created collections with `totalElements` and
`numberOfElements` following, which three list reads after creates now agree on; in two more the created collection
is listed but placed where the insert rule puts it, not where Komga sorts it (`order`). No step of any environment
agreed before and differs after.

The other environments' lists did not meet the per-line conditions or did not need them:

- NetBox's sites list was already `all`.
- Mealie's recipe lines all carry ordering or search parameters.
- Shlink's short-URL list replays (`query-varies`).
- n8n's workflow list is `list-differs`.

Their remaining differences are elsewhere: sets the application returns in varying order, writes the capture never
confirmed, preconditions such as n8n's archive-before-delete, and, for Sentry, values the capture's preparation
replaced before inspection.
