# Serve tool calls from the environment state

Issue: https://github.com/morluto/rea/issues/4933

## Outcome

`rea environment-serve <manifest> --evidence <capture> --state <state.json>`
serves the environment from the initial state the `environment-state` view
extracted: read tools whose views are state-backed answer from one live state,
the `/agentenv` data plane implements `data/reset`, `data/add` and `data/get`
against it, and the card advertises those operations and an intake
declaration. Without `--state` nothing changes: tools replay their recordings,
`/agentenv` answers every method as not found and the card is byte-identical.
Serving is read-only in this increment: write tools are not served.

## Requirements

- Authenticate the state file as REA Evidence with the role `state`, require
  `inspect_analysis_view` Evidence of kind `environment-state`, its
  `parent_evidence_id` equal to the capture's `evidence_id`, its
  `template_rules` equal to the manifest's in the same order, and every view
  naming a manifest tool; refuse otherwise with `invalid_request` whose issue
  path starts with `state`, before binding.
- Keep one state store per server process, shared by every MCP session and the
  data plane: entities keyed by type, collection and id with per-collection
  order taken from the entities array, documents keyed by tool. `reset`
  restores the Evidence state, `replace` installs a validated document whole,
  and mutations are synchronous.
- Answer item views by rendering the entity the path arguments name into the
  recorded envelope of `envelope_ordinal`. Match arguments as replay does: a
  held collection segment equal to the argument as written or after
  percent-decoding, preferring verbatim spellings, and the identity as the last
  argument percent-decoded, then as written, never re-split on `/`. Any held
  entity answers, and query arguments only set `replay.exact_match`. Refuse an
  entity the state does not hold, or one lacking a required field, as a tool
  error and never invent a body.
- Answer list views from the state only when the arguments name one of the
  view's `checked_record_ordinals` exactly (every path and query value equal and
  no recorded query parameter unsupplied), choosing among them as replay
  chooses: every collection entity in state order for `membership: "all"`,
  otherwise the recorded members the state still holds. Lines recorded after a
  write or with other filters were never checked and answer from recordings.
- Answer document views with the state's value when the arguments name the
  document's checked line exactly.
- Answer recorded views, tools without a view and unrecorded requests from the
  recording, labelled `state: {source: "recording", reason}`; label state
  answers `state: {source: "state", view, …}` with the base record's replay
  provenance and `truncated: false`; refuse a state answer over 256 KiB as a
  tool error rather than cut it.
- Serve `data/reset` (`{}`), `data/add` with exactly one `data` or `file` part
  (`bytes`, a `file://` regular file or an `https://` download with a 30 s
  timeout covering the body, no redirects and a streamed 32 MiB cap;
  `mimeType` when given is `application/json`) and `data/get` (`{parts:
  [{kind: "data", data: rea_state}]}`). Anything else is `-32602`, including
  empty `parts`; a failed download is `-32000`; errors never echo a uri or
  content and name a coarse failure category in `error.data.reason`. Calls run
  one at a time in arrival order across requests, batches in order, and
  notifications run without a reply.
- Validate `rea-state/v1` documents against the served types and views: known
  types, collections that instantiate their template, ids equal to the identity
  field, unique keys, `view_fields` naming item or list views of the type,
  documents naming document views once at the initial path, and the optional
  `state_evidence_id` and `types` that `data/get` reports equal to the served
  ones. Refuse numbers without an exact native value and `__proto__` members.
  Name the first problem by JSON pointer, never deeper than a caller-data
  member (`fields`, `value`, `types`), and leave the state unchanged.
- Keep record citations Evidence provenance: refuse `record_ordinals` or a
  `record_ordinal` other than the Evidence's for that entity or document, and
  hold the Evidence's citations only for loaded values equal to the Evidence's;
  edited or added values cite none.
- In state mode, declare `operations: ["data/reset", "data/add", "data/get"]`
  and the `urn:agentenv:intake/v1` extension, describe tools as answering from
  the state where it backs them, and leave out `POST`, `PUT`, `PATCH` and
  `DELETE` tools other than query `POST`s. The discovery budget reserves the
  card and descriptions actually served, so stateless serving and export admit
  exactly what they did before.
- Add `--state` to the CLI, read like the other two files, and add
  `state_evidence_id` to the stopped document.

## Acceptance and limits

Services tests cover the loader refusals, store reset, order, round trip and
atomic replace, the first-problem pointers, citation provenance after a load and
every answer path: item (including percent-encoded collection segments and
ids), list `all`, list `recorded`, lines recorded after a write or with other
filters, a line replay's tie-break would not pick, document, recorded view, tool
without a view, unrecorded request, missing entity, missing required field and
the body limit. Adapters tests cover the data-plane shapes, `-32602` for empty
and malformed parts and invalid documents, inexact numbers, bytes, `file://`
and its failure categories, injected https downloads (status, declared and
streamed size, the timeout whether or not the fetcher honours its signal), the
default fetch's refused redirects, arrival-order application across requests,
batches and notifications, the card declaration, absent write tools, a served
query `POST`, the per-mode discovery reservation and a `data/add` that changes
the next tool answer over MCP. The cli-boundary test refuses a state from another
capture and an unreadable state path; the mcp-boundary test serves the three
files through the built CLI; the process-boundary test checks the stopped
document. No test reaches an external network. Write effects, exporting the
state with a bundle, list filters beyond recorded lines and `tables` in the
intake declaration are out of scope.

## Deferred issue criteria

Write effects and exporting the state with a bundle are later increments of
#4933. This PR must reference rather than close the issue.
