import type { JsonValue } from "../jsonValue.js";
import { same, type JsonObject } from "./environmentStateRules.js";
import type { FieldRule } from "./environmentStateWriteRules.js";
import { integerOf, slugOf } from "./environmentStateWriteValues.js";

/** Whether a rule changes its field on calls that do not send it: serving applies it to every call that could. */
export const unsentChange = (rule: FieldRule): boolean =>
  rule.rule === "increment" || rule.rule === "slug";

/** Whether serving gives a rule's field a new value on every call, so no call may have kept it. */
export const regenerates = (rule: FieldRule): boolean =>
  rule.rule === "unique" || rule.rule === "renewed";

/** The fields a call showed as they were before it. */
export const keptFields = (before: JsonObject, after: JsonObject): string[] =>
  Object.keys(after).filter(
    (field) =>
      Object.hasOwn(before, field) && same(before[field], after[field]),
  );

/** Whether a plan's rules give a recorded call another value than it showed, or one of them regenerates a field the call kept. */
export const disagreesWithCall = (
  rules: readonly FieldRule[],
  call: {
    readonly written: JsonObject;
    readonly after: JsonObject;
    readonly kept: readonly string[];
  },
): boolean =>
  rules.some(
    (rule) =>
      (unsentChange(rule) &&
        Object.hasOwn(call.after, rule.field) &&
        !same(call.written[rule.field], call.after[rule.field])) ||
      (regenerates(rule) && call.kept.includes(rule.field)),
  );

/** A call's scalar members by name, as much of it as later rules are checked against. */
export const scalars = (object: JsonObject): Map<string, JsonValue> =>
  new Map(
    Object.entries(object).filter(
      ([, value]) => value === null || typeof value !== "object",
    ),
  );

/** The scalar values a modelled update call showed and sent, and the fields it kept, which later rules must reproduce. */
export interface UpdateCall {
  readonly shown: ReadonlyMap<string, JsonValue>;
  readonly sent: ReadonlyMap<string, JsonValue>;
  readonly kept: readonly string[];
}

/** Whether a rule a later call showed gives an earlier call a value other than the one it showed for a field it did not send. */
export const contradictsEarlierCalls = (
  draft: {
    readonly plan: { readonly rules: readonly FieldRule[] };
    readonly updates: readonly UpdateCall[];
  },
  rules: readonly FieldRule[],
): boolean => {
  const ruled = new Set(draft.plan.rules.map((rule) => rule.field));
  return rules.some(
    (rule) =>
      (unsentChange(rule) || regenerates(rule) || rule.rule === "clock") &&
      !ruled.has(rule.field) &&
      draft.updates.some(({ shown, sent, kept }) => {
        if (regenerates(rule)) return kept.includes(rule.field);
        // An unruled field an earlier call showed is one it left as it was.
        const value = shown.get(rule.field);
        if (value === undefined) return false;
        if (rule.rule === "increment") return integerOf(value) !== undefined;
        // Serving stamps a clock on every call, so a field an earlier call kept contradicts it.
        if (rule.rule === "clock") return true;
        const from = rule.rule === "slug" ? sent.get(rule.from) : undefined;
        return typeof from === "string" && slugOf(from) !== value;
      }),
  );
};
