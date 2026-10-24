# Explain values an application derives from other fields

Issue: https://github.com/morluto/rea/issues/4933

## Outcome

Environments an agent built from a prompt withheld creates in three of five applications, each for a value the write
model could not explain, though the application derives it deterministically:

- Linkding's `web_archive_snapshot_url` is `https://web.archive.org/web/<creation time as YYYYMMDDhhmmss>/<sent url>`.
  The plan kept it as a constant, which pinned `url` to its recorded value, so a later create with another URL was
  refused.
- Grafana's folder `url` is `/dashboards/f/<uid>/<slug of the title>`, which pinned `uid` the same way, and its numeric
  `id` is a large time-based integer the plan copied from the first create, which the second create's read-back
  contradicted.
- Homebox, written in Go, spells nanosecond clocks with trailing fraction zeros dropped (`…34.38812218Z`), so a later
  create's clock did not follow the format learned from the first.

## Behaviour

- **Composed strings.** A created field no other rule explains may be a `composed` string: literal text and parts read
  from the fields other rules write, each a field's value, its slug, or a clock's calendar digits (`YYYYMMDDhhmmss`,
  `YYYYMMDD`, `YYYY-MM-DD`, `YYYY/MM/DD`, in the clock's zone). Parts are found left to right, longest first, delimited
  by non-alphanumerics; generated values may be short, other values need eight characters, as a copy does. A create
  composes a string only when at least one other entity of the type spells it with the same parts and none spells it
  otherwise, and never when one text comes from two sources serving could tell apart (two clocks the write stamps are
  one source). An update's unsent change may be composed from members it stored as sent and fields it left as they were,
  when the same parts also spell the value before the call and no other entity spells it otherwise. Serving rebuilds the
  string from the written fields after every other rule and refuses a call when a part's field holds nothing to spell,
  and a composed field no longer pins the members it reads. A composition learned on a later call is checked against
  every earlier call.
- **Trimmed clocks.** A clock format may be `trimmed`: its values differ only in how many fraction digits they show and
  none ends a fraction in a zero. It is learned from the type's held values of the field, from a later create, and from
  a later update; other clocks the plan stamps take the spelling unless their own value, or the later call's, shows a
  fixed width. `fraction` is the most digits shown, and serving drops trailing zeros and the point with them.
- **Generated integers.** A created integer of 10 to 20 digits that no entity of the type holds, where every held
  entity holds a distinct one of the same length and JSON kind and none is a clock, is `unique`. Serving draws a seeded
  integer of that length and kind that no held entity has. One that another field of the created entity also holds is
  not `unique`, and the create is withheld as `unexplained-change`, since seeding cannot keep the two equal.

Plans that need none of this are unchanged.

## Acceptance

- The prompt-built Linkding, Homebox and Grafana captures serve the creates and renames they withheld, and write
  tasks that use them pass.
- No write tool of the 50 published captures or the earlier prompt-built captures goes from served to withheld.
