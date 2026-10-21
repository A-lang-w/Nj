# Verification

Executed on macOS with Node v22.23.1 on this branch, whose base is the write-plan branch's head `325c128f`.

## Gates

- `npm run build:cached`, `npm run check:fast` (typecheck and lint, no new warnings in the changed files),
  `npm run format:check`, `npx knip`, `npm run scan:todos`, `npm run docs:check`, `npm run verify:test-discovery` and
  `npm run mcp-catalog:check`: passed.
- `npm run jscpd`: 3.43% duplicated lines over 3754 files.
- `npx vitest run --project domain --project services`: 7757 passed, 5 pre-existing skips.
- `npm run test:prepare`, then `npm run test:focused --` the environment serve and export CLI boundaries, the serve
  and served-writes MCP boundaries, the analysis-view CLI and MCP boundaries, the compact input schema boundary and
  tool schema validity: 8 files, 79 passed.

## Tests

- Manifest: a `204` write with no body is kept as a tool whatever its content type, and a write only redirected is not.
- Gate:
  - a field a read-back leaves out stops being required, and a create lacking it is served only when its own read
    leaves it out too;
  - an item view proves its identity past a read that asked for some fields only, which is left to replay;
  - creates numbered in digit groups are served.
- Serving: a created entity is served without the omitted field while seeded ones keep it; a call naming `fields`
  replays with the reason `projection` while other calls answer from the state; creates take the next number in the
  held value's digit groups.
- Unit: a digit-group value reads as a sequence and a date does not; the next value keeps the groups, overflow leading.
- The gate, serving and manifest tests fail on `325c128f`.

## Published captures

Over the 50 published captures, against `325c128f`:

- Write groups excluded as `non-json` go from 13 in five captures to none. Directus, Jellyfin, Keycloak, Miniflux and
  Shlink gain those tools, so their manifests change.
- Served write tools go from 35 to 39; none is lost:
  - Directus's provisions item view proves its identity past `GET /items/provisions/2?fields=title`, so its create and
    update are served;
  - Jellyfin's `DELETE /Items/{id}` and Shlink's `DELETE /rest/v3/short-urls/{slug}` are served.
- Airbyte's job item view stops requiring two fields its reads leave out; its verdicts are unchanged.
- Six states change: those five captures and Airbyte.
- A served smoke with manifests rebuilt by each tree applies all 39 served write tools here and all 35 on the base.

## Re-recorded capture

The Homebox capture re-recorded with a read-back after each first write numbers assets in digit groups (`000-001`, `000-002`, …). Its
create goes from `contradicted` to served with a `sequence` rule on `assetId`, and the smoke applies it and the delete.
