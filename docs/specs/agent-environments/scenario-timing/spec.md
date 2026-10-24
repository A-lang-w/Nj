# Time browser scenario records

## Outcome

Browser scenario network events record no times, so every record a scenario
projects is untimed. The environment-state view then orders records by
position, detects no overlapping requests and learns no write clock: an update
whose response carries a modification time the application sets is withheld as
`unexplained-change` however it is recorded, while a HAR of the same session
serves it with a clock rule.

Scenario network events now record when each request was observed and how long
the browser took, and scenario records carry them as HAR entries do, so a
scenario capture learns the clock a HAR does.

## Requirements

- Each `request` event carries `observed_at`, the ISO wall-clock time the
  provider observed the request start; Playwright reports no start time until
  the response.
- Each `request-finished` and `request-failed` event carries `elapsed_ms`, the
  browser's time from the request start to the end of its response, when the
  browser reports one (`timing().responseEnd >= 0`).
- Both fields are optional in the schema, so Evidence captured before them
  still parses and is read exactly as before.
- Scenario records take `startedDateTime` from `observed_at` and `time` from the
  transaction's single finished or failed event (0 without one), and say so in
  a limitation; a capture whose requests all carry `observed_at` gets the
  recorded-start-time timeline and a write clock.
- Scenario comparisons ignore both fields, as a committed built-in rule
  (`ignore_network_request_timing`).
- The added metadata is charged to the event budgets as other metadata is.

## Non-goals

- No change to HAR captures, to how the state uses times, or to what a
  record's timing means for overlap or clock rules.
- No retroactive timing of captures made before this change.
- No browser start times from response timing events: `observed_at` is the
  provider's observation, a few milliseconds after the browser started.
