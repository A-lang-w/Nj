# Spell a written clock as each view spells it

Issue: https://github.com/morluto/rea/issues/4933

## Outcome

Some applications spell one instant differently by view. Mealie's recipe reads end timestamps in `Z`
(`2026-10-21T17:06:13.710410Z`) and its recipe list in `+00:00`. The state keeps each view's own values for the entities
it recorded, so those render as recorded, but a created or updated entity has only the values the write showed. A list
read after a create therefore rendered the new recipe's clocks in the item spelling. The write gate saw a contradiction
and left the create unserved, and serving would have listed the wrong spelling.

## Behaviour

- **Learning.** While checking that an item or list view reproduces its recordings, the gate compares each recorded
  object's clock fields with the entity's stored values. A field whose recorded value always names the same instant in
  one other spelling gets that spelling in the view's optional `clock_formats`. A field the view also shows as stored, or
  spells two ways, gets none.
- **Rendering.** A stored value the view never recorded, such as one a write made, is rendered in the view's spelling.
  When the zones have the same offset the digits are kept, with the view's separator, fraction width (truncated or padded
  with zeros) and zone, so digits past milliseconds survive. Another offset or an epoch spelling is formatted from the
  instant.

The gate, serving and `data/get` render through the same function, so a served create lists with the list's spelling and
reads back with the item's.

## Acceptance

- The pilot recording's Mealie create is served on the list-query stack.
- Over the 50 published captures, one view learns a spelling (Mealie's recipe list), and every write verdict is unchanged.
- Every served write tool of the 50 captures still applies.
