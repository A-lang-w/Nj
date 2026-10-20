# Implementation plan

1. Export the Evidence file authenticator from `environmentSource.ts` with a
   `state` role, and add `environmentState.ts` to load the state Evidence for a
   loaded source and filter the tools a state serves.
2. Add `environmentStateDocument.ts` to validate `rea-state/v1` documents
   against the served types and views, and `environmentStateStore.ts` for the
   live store with reset, atomic replace and the `data/get` snapshot.
3. Export `selectsRecordedLine`, the body-taking `replayAnswer` and the path
   rule `pathValueMatches` from `environmentReplay.ts`, export one recorded-body
   predicate `stateBodyJson` from the state accumulator and `changesState` from
   the state rules, and widen `collectionPathOf` to any value with a path, so
   state answers reuse selection, matching, body and write rules.
4. Add `environmentStateAnswer.ts` for item, list and document answers and the
   recorded fallback.
5. Declare the state data plane on the card in `environmentTools.ts`, taking
   the data plane in an options object so the discovery budget reserves the
   card and descriptions actually served.
6. Add `stateIntake.ts` for parts, files and downloads (injectable fetcher and
   timeout, coarse failure categories) and `environmentDataPlane.ts` for the
   three methods, run one at a time in arrival order; let `serveEnvironment.ts`
   answer tools through an injected answer function and run data-plane methods,
   batches in order and notifications.
7. Add `--state` to `environment-serve`, loading the state after the source.
8. Cover services, adapters, cli-boundary, mcp-boundary and process-boundary
   behaviour; document the flag, the answers, the data plane and the card.

No dependency, provider or REA tool contract changes. The only new network
activity is an `https://` download that a `data/add` call names.
