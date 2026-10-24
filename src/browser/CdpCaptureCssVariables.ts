import type { InspectWebPageInput } from "../domain/browserObservation.js";
import {
  browserCssVariableItemSchema,
  type BrowserCssVariableItem,
  type BrowserCssVariables,
} from "../domain/browserObservationSchemas.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";
import { CdpCommandRejection } from "./CdpCommandRejection.js";
import {
  cdpStringValue,
  numberValue,
  recordValue,
  recordsValue,
} from "./CdpCaptureValues.js";
import type { CdpConnection } from "./CdpConnection.js";
import { optionalCdpCommand } from "./CdpOptionalCommand.js";

const MAX_RETAINED_CSS_VARIABLES = 250;
const MAX_INTAKE_CSS_VARIABLES = 2000;
const MAX_REJECTED_PREVIEWS = 3;
const MAX_PREVIEW_NAME_LENGTH = 64;

const emptyCssVariables = (
  status: BrowserCssVariables["status"],
): BrowserCssVariables => ({
  status,
  origin_scope: "same_origin",
  total: 0,
  retained_count: 0,
  items: [],
});

const safeCdpCommand = async (
  context: {
    readonly connection: CdpConnection;
    readonly sessionId: string | undefined;
    readonly signal?: AbortSignal;
  },
  method: string,
  parameters: Readonly<Record<string, unknown>>,
  limitations: string[],
): Promise<unknown | undefined> => {
  try {
    return await optionalCdpCommand(context, method, parameters, limitations);
  } catch (cause: unknown) {
    if (cause instanceof CdpCommandRejection && cause.code === -32000) {
      limitations.push(
        `${method} failed (CDP error -32000): ${cause.reportedMessage ?? "target node detached or unavailable"}.`,
      );
      return undefined;
    }
    throw cause;
  }
};

/**
 * Passively extract declared and computed CSS custom properties (variables)
 * for the root document element of an authorized page target.
 */
export const captureCssVariables = async (
  context: {
    readonly connection: CdpConnection;
    readonly sessionId: string | undefined;
    readonly input: InspectWebPageInput;
    readonly signal?: AbortSignal;
  },
  limitations: string[],
): Promise<BrowserCssVariables> => {
  if (!context.input.include_css_variables) {
    return emptyCssVariables("not_approved");
  }

  const doc = await safeCdpCommand(
    context,
    "DOM.getDocument",
    { depth: 1 },
    limitations,
  );
  if (doc === undefined) {
    return emptyCssVariables("unavailable");
  }

  const rootRecord = recordValue(recordValue(doc)?.root);
  const children = recordsValue(rootRecord?.children);
  const elementChild = children.find((c) => numberValue(c.nodeType) === 1);
  const targetNodeId =
    numberValue(elementChild?.nodeId) ?? numberValue(rootRecord?.nodeId);

  if (targetNodeId === undefined || targetNodeId <= 0) {
    return emptyCssVariables("unavailable");
  }

  const enabled = await safeCdpCommand(context, "CSS.enable", {}, limitations);
  if (enabled === undefined) {
    return emptyCssVariables("unavailable");
  }

  let computedResult: unknown;
  try {
    computedResult = await safeCdpCommand(
      context,
      "CSS.getComputedStyleForNode",
      { nodeId: targetNodeId },
      limitations,
    );
  } finally {
    await safeCdpCommand(context, "CSS.disable", {}, limitations).catch(
      () => undefined,
    );
  }

  if (computedResult === undefined) {
    return emptyCssVariables("unavailable");
  }

  const computedProps = recordsValue(
    recordValue(computedResult)?.computedStyle,
  );
  const validItems: BrowserCssVariableItem[] = [];
  let totalObserved = 0;
  let rejectedCount = 0;
  const rejectedPreviews: string[] = [];

  for (const prop of computedProps) {
    const name = cdpStringValue(prop.name);
    const value = cdpStringValue(prop.value);
    if (name === undefined || value === undefined) continue;
    if (!name.startsWith("--")) continue;

    totalObserved += 1;

    const parsed = browserCssVariableItemSchema.safeParse({ name, value });
    if (parsed.success) {
      if (validItems.length < MAX_INTAKE_CSS_VARIABLES) {
        validItems.push(parsed.data);
      }
    } else {
      rejectedCount += 1;
      if (rejectedPreviews.length < MAX_REJECTED_PREVIEWS) {
        const truncatedName =
          name.length > MAX_PREVIEW_NAME_LENGTH
            ? `${name.slice(0, MAX_PREVIEW_NAME_LENGTH - 3)}...`
            : name;
        const issue =
          parsed.error.issues[0]?.message ?? "invalid token format or size";
        rejectedPreviews.push(`${truncatedName} (${issue})`);
      }
    }
  }

  if (rejectedCount > 0) {
    const preview = rejectedPreviews.join(", ");
    const remaining =
      rejectedCount > rejectedPreviews.length
        ? ` and ${String(rejectedCount - rejectedPreviews.length)} more`
        : "";
    limitations.push(
      `${String(rejectedCount)} root CSS custom ${rejectedCount === 1 ? "property was" : "properties were"} rejected: ${preview}${remaining}.`,
    );
  }

  validItems.sort((left, right) =>
    compareUnicodeCodePoints(left.name, right.name),
  );

  const total = totalObserved;
  const status: BrowserCssVariables["status"] =
    total > MAX_RETAINED_CSS_VARIABLES ? "truncated" : "included";
  const items = validItems.slice(0, MAX_RETAINED_CSS_VARIABLES);

  if (status === "truncated") {
    limitations.push(
      `CSS custom properties were truncated to ${String(MAX_RETAINED_CSS_VARIABLES)} items (${String(total)} were observed on the root element).`,
    );
  }

  return {
    status,
    origin_scope: "same_origin",
    total,
    retained_count: items.length,
    items,
  };
};
