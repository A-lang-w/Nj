# Verification

Executed on macOS with Node v22.23.1 on this branch over the write-plan branch's head `43d98ea9`. The pilot recordings
were made against live applications on six disposable Linux VMs, each restored from a snapshot first.

## Gates

- `npm run build:cached`, `npm run check:fast` (typecheck and lint, no warnings in the changed files),
  `npm run format:check`, `npx knip`, `npm run scan:todos`, `npm run docs:check`, `npm run verify:test-discovery` and
  `npm run mcp-catalog:check`: passed.
- `npm run jscpd`: 3.43% duplicated lines over 3751 files.
- `npx vitest run --project domain --project services`: 7733 passed, 5 pre-existing skips.
- `npm run test:prepare`, then `npm run test:focused --` the environment serve and export CLI boundaries, the serve
  and served-writes MCP boundaries, the analysis-view CLI and MCP boundaries, the compact input schema boundary and
  tool schema validity: 8 files, 79 passed.

## Tests

- Gate: a renamed book renewing a sent `version_id` and its chapters' ids is served with `unique` and `renewed`
  rules; two creates sending a `handle` stored as `code` and embedded in `link` are served with `copy` and
  `template` rules.
- Serving: each served update gets a fresh version and new chapter ids that keep their titles; a served create with
  a new handle stores it as the code and rebuilds the link.
- Unit: the explanation, including a UUID another entity holds (not `unique`), a child row whose text changed (not
  `renewed`), and a member copied only in part (still fixed); the renewal helpers; applying both update rules.
- The four gate and serving tests fail on `43d98ea9`.

## Pilot recordings

Each application was reset, then recorded with the capture's reads and, per write target, two scratch objects whose
every write was read back at once (item and list), deletes read back as 404.

| Application | Write                                 | Before               | After  |
| ----------- | ------------------------------------- | -------------------- | ------ |
| Shlink      | `post_rest_short_urls`                | `unexplained-change` | served |
| n8n         | `patch_rest_workflows_by_workflow_id` | `unexplained-change` | served |
| Mealie      | `patch_recipes_by_recipe_id`          | `unexplained-change` | served |

No other verdict of the six recordings changed. Built on the list-query stack (#5800 with #5699 merged), the
held-out sessions of the same applications agree on two more steps each for Mealie (294 to 296 of 310), n8n (127 to
129 of 143) and Shlink (126 to 128 of 137); Komga, NetBox and Sentry are unchanged.

## Published captures

- Over the 50 published captures, every write verdict is unchanged: 31 served write tools. The only plan that
  changes is Shlink's unserved create, which now accepts `customSlug` and templates `shortUrl`.
- An earlier version also made echoed values template sources. It templated Grafana's folder `url` around `uid`
  (the URL also holds a slug of the title) and BookStack's page HTML around its markdown. Echoed values are no
  longer sources.
- The served smoke applies all 31 served write tools, as on `43d98ea9`.
