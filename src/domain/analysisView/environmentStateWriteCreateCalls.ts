import type { JsonValue } from "../jsonValue.js";
import { same, type JsonObject } from "./environmentStateRules.js";
import { storedKinds } from "./environmentStateWriteApply.js";
import { fittedClockFormat } from "./environmentStateWriteClockFormats.js";
import type { FieldRule, WriteBody } from "./environmentStateWriteRules.js";

type Default = { readonly member: string; readonly value: JsonValue };

/** The plan's rule for a field and a later call's agree: equal, or clocks one spelling covers. */
const agreeing = (
  held: FieldRule,
  later: FieldRule,
  values: {
    readonly exemplar: JsonValue | undefined;
    readonly later: JsonValue | undefined;
  },
): FieldRule | undefined => {
  if (same(held, later)) return held;
  if (held.rule !== "clock" || later.rule !== "clock") return undefined;
  const format = fittedClockFormat(held.format, values.later, values.exemplar);
  return format === undefined ? undefined : { ...held, format };
};

/** Defaults joined, undefined when two calls showed one member left out at different values. */
const joinedDefaults = (
  held: readonly Default[],
  added: readonly Default[],
): Default[] | undefined => {
  const joined = new Map(held.map((entry) => [entry.member, entry.value]));
  for (const { member, value } of added) {
    if (joined.has(member) && !same(joined.get(member), value))
      return undefined;
    joined.set(member, value);
  }
  return [...joined].map(([member, value]) => ({ member, value }));
};

/**
 * A create plan widened by a later call the plan does not take, explained on its own: both calls show the same fields,
 * every field both rule they rule alike, a field neither rules holds one value, and where only one echoes a member the
 * other left out, the member becomes optional with the value the call that left it out stored. Members either call sent are accepted, and only those every
 * call sent are required. Undefined when the calls disagree otherwise, so the later call stays unexplained.
 */
export const mergedCreatePlan = (
  plan: { readonly rules: readonly FieldRule[]; readonly body: WriteBody },
  exemplar: JsonObject,
  later: {
    readonly entity: JsonObject;
    readonly body: JsonObject;
    readonly rules: readonly FieldRule[];
    readonly contract: WriteBody;
  },
): { readonly rules: FieldRule[]; readonly body: WriteBody } | undefined => {
  const fields = Object.keys(exemplar);
  if (
    fields.length !== Object.keys(later.entity).length ||
    !fields.every((field) => Object.hasOwn(later.entity, field))
  )
    return undefined;
  const held = new Map(plan.rules.map((rule) => [rule.field, rule]));
  const shown = new Map(later.rules.map((rule) => [rule.field, rule]));
  const rules: FieldRule[] = [];
  const defaults: Default[] = [];
  for (const field of fields) {
    const before = held.get(field);
    const after = shown.get(field);
    if (before !== undefined && after !== undefined) {
      const rule = agreeing(before, after, {
        exemplar: exemplar[field],
        later: later.entity[field],
      });
      if (rule === undefined) return undefined;
      rules.push(rule);
    } else if (before !== undefined) {
      // The plan echoes a member this call left out: what it stored there is the member's default.
      if (before.rule !== "echo" || Object.hasOwn(later.body, field))
        return undefined;
      rules.push(before);
      defaults.push({ member: field, value: later.entity[field]! });
    } else if (after !== undefined) {
      // This call echoes a member the plan's calls left out: what they stored there is its default.
      if (after.rule !== "echo" || plan.body.required.includes(field))
        return undefined;
      rules.push(after);
      defaults.push({ member: field, value: exemplar[field]! });
    } else if (!same(exemplar[field], later.entity[field])) return undefined;
  }
  const body = mergedBody(plan.body, later, exemplar);
  const joined =
    body === undefined
      ? undefined
      : joinedDefaults(plan.body.defaults ?? [], defaults);
  if (body === undefined || joined === undefined) return undefined;
  return {
    rules,
    body: joined.length === 0 ? body : { ...body, defaults: joined },
  };
};

/** Two calls' body contracts joined, undefined when a member one accepts with any value the other fixes, or both fix it at different values. */
const mergedBody = (
  body: WriteBody,
  later: {
    readonly body: JsonObject;
    readonly contract: WriteBody;
    readonly entity: JsonObject;
  },
  exemplar: JsonObject,
): WriteBody | undefined => {
  const fixed = new Map(body.fixed.map((entry) => [entry.member, entry.sent]));
  const { contract } = later;
  if (
    contract.accepted.some((member) => fixed.has(member)) ||
    contract.fixed.some(
      (entry) =>
        body.accepted.includes(entry.member) ||
        (fixed.has(entry.member) && !same(fixed.get(entry.member), entry.sent)),
    ) ||
    contract.envelope !== body.envelope
  )
    return undefined;
  const added = contract.accepted.filter(
    (member) => !body.accepted.includes(member),
  );
  return {
    ...body,
    accepted: [...body.accepted, ...added],
    fixed: [
      ...body.fixed,
      ...contract.fixed.filter((entry) => !fixed.has(entry.member)),
    ],
    required: body.required.filter((member) =>
      Object.hasOwn(later.body, member),
    ),
    identity: body.identity ?? contract.identity,
    kinds: [...body.kinds, ...storedKinds(added, exemplar, later.entity)],
  };
};
