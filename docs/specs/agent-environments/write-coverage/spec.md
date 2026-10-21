# Wider write coverage

Issue: https://github.com/morluto/rea/issues/4933

## Outcome

Four recording shapes kept write tools out of the manifest or left their writes unserved, although the recordings showed
what the writes did:

- **Bodiless replies.** A write answered `204` with no body (Jellyfin's and Shlink's deletes, Miniflux's and Keycloak's
  updates) had no JSON-like content type, so its group was excluded as `non-json` and never became a tool.
- **Omitted fields.** A field every recording of a view carried was required, so an application that leaves empty or
  false members out of some entities (Go's `omitempty`) made the write gate refuse its own read-backs.
- **Projected reads.** An item read asking for some fields only (Directus's `/items/provisions/2?fields=title`) does not
  repeat the requested id, so it blocked the identity proof of the whole item view, and the view's writes had no state
  target.
- **Digit-group sequences.** A sequence spelled in digit groups (Homebox's asset number `000-005`) was not an integer, so
  a create that numbers it had no rule for it and was contradicted.

## Behaviour

- **Manifest.** A write group (`POST`, `PUT`, `PATCH`, `DELETE`) is kept as a tool when every response had no body (a
  `204` or `205`, an empty text, or a recorded size of zero) and one succeeded. A missing text alone does not count.
- **Omitted fields.** The write gate notes required fields missing from the entities that successful reads it checks
  return: the item whose id the path names, or the listed items carrying an id. The state's views stop requiring them.
- **Projected reads.** An item read naming `fields`, `fields[...]`, `select` or `$select` that does not return the item
  is left out of the identity proof and the view's checks. The view lists it in `projected_record_ordinals`, and serving
  replays a call to that tool naming such a parameter with the reason `projection`.
- **Sequences.** A sequence value may be digit groups, not an ISO date. The next value keeps the exemplar's groups and
  zero padding; digits that outgrow them lead.

## Acceptance

- Over the 50 published captures, no write group is excluded as `non-json`, served write tools rise from 35 to 39, and
  no write tool is served on the base and unserved here.
- The re-recorded Homebox capture's create is served.
- Every served write tool of those captures applies.
