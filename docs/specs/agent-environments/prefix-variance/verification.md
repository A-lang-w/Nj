# Verification

Verified base: 6d8aa4b7 on main 1629266e, plus the removal of the type alias
`knip` reported. Executed on macOS with Node v22.23.1 (the repository pins
24.18.0 in `.nvmrc`, which was not installed).

## Gates

- `npm run build:cached`, `npm run check:fast` (typecheck and lint),
  `npm run format:check`, `npx knip`, `npm run scan:todos`,
  `npm run docs:check`, `npm run verify:test-discovery` and
  `npm run mcp-catalog:check`: passed.
- `npm run jscpd`: 3.49% duplicated lines over 3560 files with 3067 clones;
  main measures 3.49% with 3068, since the shared segment-limit split removes
  one clone.
- oxlint reports no new finding on the changed files. The manifest accumulator
  keeps main's three warnings (file length, and the complexity and parameter
  count of its record append), one line longer.
- `npx vitest run --project domain --project services`: 7118 passed, 5
  pre-existing skips.
- `npm run test:prepare`, then `npm run test:focused --` the analysis-view MCP
  and CLI boundaries, the compact input schema and tool schema validity
  boundaries, and the environment serve and export boundaries:
  7 files, 76 passed.

New tests in `environmentManifestView.test.ts` cover:

- a literal shared across methods and depths, and the same capture without the rule;
- the spelling condition: same classes and length, case, missing digit, a colon word, a version;
- merges that keep a tool's own rule, including a sibling-variance parameter under a shared one;
- both halves of a templated pair;
- format-rule positions and the segment limit.

## The showcase captures

The 50 showcase captures (45 HAR inspections and 5 `capture_browser_scenario`
captures) were projected with main's build and this branch's.

- Without the rule, both builds give identical results for every capture: the
  manifest with no rules, the manifest with `after-uid-literal`,
  `opaque-token`, `sibling-variance` and `sibling-pair-variance`, and the
  environment-state view. 150 of 150 outputs hash equal.
- With `prefix-variance` added to `after-uid-literal`, `opaque-token` and
  `sibling-variance`, 59 literal tools in 10 captures are templated, 25 of them
  writes:
  - Komga: collection and readlist `PATCH` and `DELETE`, book pages.
  - n8n: workflow `PATCH`, `DELETE` and archive.
  - Memos: memo `PATCH` and `DELETE`, and user settings reads.
  - Navidrome: playlist `PUT` and `DELETE`.
  - Mealie: recipe `PATCH` and `DELETE`.
  - Grist: document `PATCH` and `DELETE`, and table record writes.
  - Redpanda Console: subject and topic writes.
  - Sentry: release `PUT` and `DELETE`.
  - Shlink: short URL `PATCH`.
  - Mattermost: `me` reads, which `sibling-variance` already folds into the
    user parameter.

  Tools go from 1591 to 1588, because Redpanda Console's per-subject reads
  merge.

- Literals the rule leaves alone, as intended, include Espo CRM `layout`,
  Federal Register `facets`, Ghost `slug`, Shlink `stats`, Lychee
  `Metrics::photo` and Vault's path names.
- The environment-state view succeeds on every capture with the rule. Its types
  move to the templated collections; the one fewer item view is the Redpanda
  Console merge.

With the write plans of #5600 (its branch with this commit and main merged in,
locally):

- Served write tools rise from 33 to 39: Komga collection create, update and
  delete; n8n workflow delete; Sentry release update and delete.
- Write tools with no state target fall from 102 to 87.
- The newly modelled tools that stay unserved are limited by the capture:
  - no read after the write: Komga readlists, Mealie, Navidrome, Redpanda Console;
  - n8n's item read shows an expanded `shared` relation its create response
    never returned;
  - Shlink returns `tags` sorted while the update echoes the request's order.
