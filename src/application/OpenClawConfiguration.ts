import JSON5 from "json5";
import { parseExpression } from "@babel/parser";
import type { ObjectExpression, ObjectProperty } from "@babel/types";
import { createScanner, type SyntaxKind } from "jsonc-parser";
import { z } from "zod";

const object = z.record(z.string(), z.unknown());
const keyOf = (property: ObjectProperty): string =>
  property.key.type === "Identifier"
    ? property.key.name
    : property.key.type === "StringLiteral"
      ? property.key.value
      : "";

const tree = (text: string): ObjectExpression => {
  const expression = parseExpression(text);
  if (expression.type !== "ObjectExpression")
    throw new SyntaxError("OpenClaw configuration must be an object");
  return expression;
};
const properties = (node: ObjectExpression): ObjectProperty[] =>
  node.properties.filter(
    (property): property is ObjectProperty =>
      property.type === "ObjectProperty",
  );
const member = (
  node: ObjectExpression,
  key: string,
): ObjectProperty | undefined => {
  const matches = properties(node).filter(
    (property) => keyOf(property) === key,
  );
  if (matches.length > 1)
    throw new SyntaxError(`Ambiguous OpenClaw configuration member: ${key}`);
  return matches[0];
};

/** Semantic JSON5 parsing; the syntax tree is used only for exact edit positions. */
export const parseOpenClawConfiguration = (
  text: string,
): Record<string, unknown> => {
  const source = text.trim() === "" ? "{}" : text;
  const document = object.parse(JSON5.parse(source));
  let node = tree(source);
  for (const key of ["mcp", "servers", "rea"]) {
    // Includes need native multi-file ownership; never flatten their unresolved data.
    if (member(node, "$include") !== undefined)
      throw new SyntaxError(
        "OpenClaw include-directed MCP configuration requires native editing",
      );
    const property = member(node, key);
    if (property === undefined || property.value.type !== "ObjectExpression")
      break;
    node = property.value;
  }
  return document;
};

const JSON_COMMA = 5 satisfies SyntaxKind;

// Trivia between properties contains only comments, whitespace and a comma.
const commaAt = (
  text: string,
  start: number,
  end: number,
): number | undefined => {
  const scanner = createScanner(text.slice(start, end), true);
  return scanner.scan() === JSON_COMMA
    ? start + scanner.getTokenOffset()
    : undefined;
};

/** Edit only the owned registration; retain every unrelated JSON5 source span. */
export const editOpenClawConfiguration = (
  text: string,
  document: Record<string, unknown>,
): string => {
  parseOpenClawConfiguration(text);
  const mcp = object.parse(document.mcp ?? {});
  const servers = object.parse(mcp.servers ?? {});
  const value = servers.rea;
  let node = tree(text);
  const path = ["mcp", "servers", "rea"];
  for (let index = 0; index < path.length; index++) {
    const key = path[index]!;
    const property = member(node, key);
    if (property === undefined) {
      if (value === undefined) return text;
      let nested: unknown = value;
      for (const parent of path.slice(index + 1).reverse())
        nested = { [parent]: nested };
      const last = properties(node).at(-1);
      const end = node.end! - 1;
      const comma =
        last !== undefined && commaAt(text, last.end!, end) === undefined
          ? ","
          : "";
      return (
        text.slice(0, end) +
        comma +
        `\n${JSON.stringify(key)}: ${JSON.stringify(nested, null, 2)}\n` +
        text.slice(end)
      );
    }
    if (index !== path.length - 1) {
      if (property.value.type !== "ObjectExpression")
        throw new SyntaxError("OpenClaw MCP containers must be objects");
      node = property.value;
      continue;
    }
    if (value !== undefined)
      return (
        text.slice(0, property.value.start!) +
        JSON.stringify(value, null, 2) +
        text.slice(property.value.end!)
      );
    const members = properties(node);
    const position = members.indexOf(property);
    const next = members[position + 1];
    const previous = members[position - 1];
    const followingComma = commaAt(
      text,
      property.end!,
      next?.start ?? node.end! - 1,
    );
    const comma =
      followingComma ??
      (previous === undefined
        ? undefined
        : commaAt(text, previous.end!, property.start!));
    const edits = [
      { start: property.start!, end: property.end! },
      ...(comma === undefined ? [] : [{ start: comma, end: comma + 1 }]),
    ];
    for (const edit of edits.sort((a, b) => b.start - a.start))
      text = text.slice(0, edit.start) + text.slice(edit.end);
    return text;
  }
  return text;
};
