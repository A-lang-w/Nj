# Implementation plan

1. **Gate.** Judge each latest list recording on its own for paging-only query, totals, next page and state order;
   keep `all` when every line passes and otherwise name the passing lines in `all_record_ordinals`; reproduce each
   line with its own membership.
2. **Counters.** Count `number`-of-items members as item totals.
3. **Consumers.** One helper says whether a view lists all on a line; serving, the write gate's list checks and the
   insert retry use it, and an argument-less call may answer on any such line.
4. **Tests and docs.** Domain and serving tests as the acceptance lists; the membership row of the environment-state
   docs and the list answer row of the agent-environment docs.
