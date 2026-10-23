import type {
  StateWritePlan,
  WriteBody,
} from "../../domain/analysisView/environmentStateWriteRules.js";
import {
  describeList,
  quotedName,
  type EnvironmentToolProperty,
} from "./environmentTools.js";

/** Captured member names, quoted and sampled as response fields are; the plan in the state Evidence holds every one. */
const members = (names: readonly string[]): string =>
  describeList(names, names.length, quotedName, "state Evidence");

/** The body members a served write accepts, as a description clause. */
const bodyClause = (
  body: WriteBody,
  effect: StateWritePlan["effect"],
  action = false,
): string => {
  const parts: string[] = [];
  if (body.accepted.length > 0)
    parts.push(`body members ${members(body.accepted)}`);
  if (body.fixed.length > 0)
    parts.push(
      `${members(body.fixed.map(({ member }) => member))} only with the value the capture sent`,
    );
  if (body.required.length > 0)
    parts.push(`required: ${members(body.required)}`);
  else if (effect === "update" && !action) parts.push("send at least one");
  return parts.length === 0 ? "" : ` (${parts.join("; ")})`;
};

/** What a served write tool does to the state, for its description; undefined for a tool the state does not serve. */
export const describeWrite = (
  plan: StateWritePlan | undefined,
): string | undefined => {
  if (plan?.served !== true) return undefined;
  const { address } = plan;
  const body =
    plan.body === null
      ? ""
      : bodyClause(plan.body, plan.effect, address?.by === "action");
  if (address !== undefined && address.by !== "action")
    return plan.effect === "delete"
      ? "removes the entities its body names by id from the served environment state, modelled on the recorded calls"
      : `changes the entities its body names by id in the served environment state${body}, modelled on the recorded calls`;
  if (address?.by === "action")
    return `applies ${quotedName(address.segment)} to the entity the path names in the served environment state${body}, modelled on the recorded calls`;
  switch (plan.effect) {
    case "create":
      return `creates an entity of ${plan.target ?? ""} in the served environment state${body}, modelled on the recorded calls`;
    case "update":
      return `changes the entity the path names in the served environment state${body}, modelled on the recorded calls`;
    case "delete":
      return "removes the entity the path names from the served environment state, modelled on the recorded calls";
    case "document":
      return `changes a document of the served environment state${body}, modelled on the recorded calls`;
    case "none":
      return undefined;
  }
};

/** The body a served bulk write takes: the recorded form naming its entities by id, an array or an object. */
export const writeBody = (
  plan: StateWritePlan | undefined,
): EnvironmentToolProperty | undefined => {
  const address = plan?.served === true ? plan.address : undefined;
  if (address === undefined || address.by === "action") return undefined;
  const ids =
    address.by === "ids"
      ? "an array of entity ids"
      : "an array of objects each carrying its entity's id field";
  const items = {
    type: address.by === "ids" ? address.kind : "object",
  } as const;
  return address.member === null
    ? {
        type: "array",
        items,
        description: `Request body: ${ids}, as recorded.`,
      }
    : {
        type: "object",
        description: `Request body: ${quotedName(address.member)} holds ${ids}, as recorded.`,
      };
};
