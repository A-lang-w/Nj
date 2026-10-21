# Serve writes whose values the application renames or regenerates

Issue: https://github.com/morluto/rea/issues/4933

## Outcome

Recordings made to show each write's effect, with every write read back at once and two scratch objects per tool,
still left writes unserved where the application stored a value in a way the write rules did not explain:

- a create's member stored under another name: Shlink stores `customSlug` as `shortCode`, and its `shortUrl` ends in
  it, so every slug but the recorded one was refused;
- an update that gives a field a fresh UUID each time: n8n's `versionId`, which the client sends back with the
  version it read;
- an update that rewrites child rows with new UUIDs: Mealie gives a recipe's instructions new ids on every update.

These writes are now explained and served.

## Rules

- **Creates.** A member copied whole into a field of another name is accepted with any value. A string that contains
  a copied value as a delimited token is a template of the copying field and is rebuilt around the new value; the
  copied value has the copy rule's 8 characters at least. Echoed values make no templates, since an echoed name may
  recur in unrelated text.
- **Updates.**
  - `unique`: a field that held a UUID and now holds another, which the call did not send and no other entity of
    the type holds. A sent member replaced this way is accepted with any value.
  - `renewed`: an array or object whose only changes are UUIDs replaced by ones it did not hold, each old UUID by a
    single new one. A lone UUID is never renewed: it is either `unique` or unexplained.
- **Serving.** A `unique` field gets a UUID derived as for creates. A `renewed` field keeps the entity's current
  value with each distinct UUID inside it replaced by one derived the same way.

The gate takes the recorded values for both, as for other generated fields, and a later call must rule a field the
same way.

## Acceptance

- The pilot recordings' Shlink create, n8n update and Mealie update are served, and no other verdict changes.
- The 50 published captures keep every verdict; only Shlink's unserved create plan changes, accepting
  `customSlug` and templating `shortUrl`.
- Every served write tool of the 50 captures still applies.
- A unit test shows a UUID another entity holds is not `unique`, and a child row whose text changed is not `renewed`.
