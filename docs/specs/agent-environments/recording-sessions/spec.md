# Build an environment from several recording sessions

Issue: https://github.com/morluto/rea/issues/4933

## Outcome

An environment is built from what its capture shows. When one recording writes once and never reads the result back,
the write stays unserved, and a call the recording never made is answered from no evidence at all. More recordings
of the same application are the natural fix, but REA reads a capture as one session: appended to the first, a second
recording's reads come after the first one's writes, so they are not views of the initial state, and its writes are
replayed on top of the first one's.

A capture may now hold several **recording sessions**, each recorded against the application restored to the same
state (for example one database snapshot). Each session's reads before its own first related write show the initial
state, and each session's writes are replayed from that state, so a write any session confirms is served unless
another session contradicts it. A capture without sessions is read exactly as before.

## Request

`environment-manifest` and `environment-state` view requests accept `session_starts`: the ordinals of the records
where a later session begins, strictly ascending positive integers. The first session starts at the capture's start.
A HAR record's ordinal is its zero-based index in `log.entries`, so a second recording appended to a first starts at
the first's entry count. Absent (or empty), the capture is one session, and the echoed request is unchanged, so
existing manifests and states keep their Evidence ids.

The manifest does not group by session. It records `session_starts` so that every command deriving the state from a
manifest and its capture (`environment-serve`, `environment-export`) derives it with the same sessions, and a
supplied state whose `session_starts` differ from the manifest's is refused like one extracted with other template
rules.

## Initial state

- Records are ordered by session, then within a session by recorded start time (or record order), so sessions that
  overlap in time stay apart.
- A type's initial recordings in each session are its successful reads that finished before that session's first
  write under a related root. `init_before_ordinal` names the first such write in timeline order.
- A change between two observations lies across a write when, in one session, a write overlaps the span between
  them, or, across sessions, the later session wrote before the later observation, since each session starts from
  the initial state. A value two sessions' initial reads disagree on with no such write is therefore volatile; with
  one, the type's views are `fields-differ`, as within a session.
- A limitation counts the sessions and says that they start from one state is the caller's statement, which the view
  does not establish.

## Write gate

Each session is replayed on its own copy of the initial state, with its own taint, its own unmodelled writes and its
own record of what was checked, and a later observation of a written entity is searched for only within the write's
session. Plans are built once, from each tool's first successful call in timeline order, and every session's
confirmations and contradictions count toward the verdict: a plan is served when a read in some session confirms it
and no read in any session contradicts it.

## Acceptance

- Domain tests: a create repeated after a reset is confirmed, and read as one session it is contradicted; a write one
  session confirms and another contradicts is withheld; a later session's reads before its own writes back an item
  view; a value the sessions' initial reads disagree on is volatile, and `fields-differ` when the later session wrote
  first; sessions that overlap in time stay together; request validation.
- A service test: the state derived from a manifest with sessions is the state view requested with them, and a state
  extracted without them is refused for that manifest.
- Measured on the six applications compared in the fidelity comparison: environments built from a re-run of the
  capture alone, from that re-run plus one training session per write target, and from the same recordings read as
  one session, each compared with held-out sessions the training never sent.

There are no dependency or provider changes and no new network activity.
