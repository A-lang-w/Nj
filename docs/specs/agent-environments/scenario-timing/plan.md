# Plan

1. Schema: optional `observed_at` (ISO date-time) on `request` events and
   `elapsed_ms` (non-negative number) on `request-finished` and
   `request-failed` events.
2. Collector: stamp `observed_at` from an injectable wall clock when a request
   is observed, admitting it with the other metadata strings, and copy the
   browser's `timing().responseEnd` into `elapsed_ms` when it is known.
3. Records: index each transaction's finished or failed duration and give each
   attributable record `startedDateTime` and `time`; add a limitation when any
   record is timed.
4. Comparison: drop both fields from network evidence before fingerprinting and
   commit the rule in the built-in list and the comparison limitation.
5. Docs: the scenario contract's network evidence and the environment docs'
   browser scenario section.
6. Tests: the collector stamps both fields, records take them, the state learns
   the HAR's clock and verdicts from a timed scenario and none from an untimed
   one, comparisons ignore them, and the real-Chrome network lane checks every
   request and finished response is timed.
