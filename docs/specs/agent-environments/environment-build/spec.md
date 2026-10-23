# Build an environment in one step

Issue: https://github.com/morluto/rea/issues/4933

## Outcome

Building an agent environment bundle takes three commands and a hand-written
view request that embeds the whole capture inline, so large captures hit inline
input accounting. The views apply no opt-in template rules by default, while the
published capture-built environments all use the same four, and a local capture
is named after its origin host (`127-0-0-1-3105`). Nothing reports which tools
an environment serves from its state, or why a write tool is withheld.

`rea environment-build <capture> [directory]` builds the bundle in one offline
step and reports what it serves. A new `environment-coverage` analysis view
reports the same summary for any capture, so an agent can check a recording
before building.

## Requirements

- The capture is a `.har` file, inspected as `inspect-web-network-capture`
  inspects it, or capture Evidence JSON from `inspect_web_network_capture` or
  `capture_browser_scenario`; anything else is refused before it is read.
- The manifest is projected from the in-memory capture as retained Evidence,
  with the default rules `after-uid-literal`, `opaque-token`,
  `sibling-variance` and `prefix-variance` unless `--template-rule` or
  `--format-rules-only` selects others; rules apply in the views' order.
- For the same capture path and options, every bundle file is byte-identical
  to what `inspect-web-network-capture --format json`, `inspect-analysis-view
  --format json` and `environment-export` write, Evidence ids included.
- The name is `--name`, else the manifest's, unless the origin is a loopback
  name or IP literal: then the capture file's name, with a warning; a file name
  that yields no label is refused.
- The report extends the export document with the capture and manifest
  identities, the state, `coverage`, warnings and the next command. `coverage`
  counts read tools answered from the state and replayed (per view reason), and
  lists write tools as served or withheld with their reason, plan record, the
  contradicting read and a hint; it is null when the state is unavailable.
- Every write reason has a hint; a reason without one fails to compile.
- Credential-named body members with a string value are reported as a count
  and the first 20 record pointers, never values, and never refuse a build.
- Nothing is written before the bundle stage; `--dry-run` writes nothing and
  reports the files a build would write. The directory must be absent or empty.
- The `environment-coverage` view summarizes the environment-state view with
  the same rules, refuses what it refuses and is inferred.
- The `real-agentenv` lane builds its bundle with `environment-build`.

## Non-goals

- No change to the three existing commands' contracts, or to what any view
  derives or any environment serves.
- No browser launch or network access: scenarios are recorded with
  `capture-browser-scenario` first.
- No `--replace`, no refusal on credential names, and no rewriting of the
  capture's absolute path, which Evidence identity includes.
- No MCP export tool; that is a separate change.
