import {
  Alias,
  isAlias,
  isMap,
  isNode,
  isSeq,
  visit,
  type Document,
  type Node,
} from "yaml";

interface AliasCopies {
  readonly document: Document;
  readonly retained: Map<Node, Node>;
  readonly visiting: Set<Node>;
  readonly names: Set<string>;
}

const copyAliasComments = (source: Alias, copy: Node): Node => {
  delete copy.commentBefore;
  delete copy.comment;
  if (source.commentBefore !== undefined)
    copy.commentBefore = source.commentBefore;
  if (source.comment !== undefined) copy.comment = source.comment;
  return copy;
};

/** Keep source bindings, including nested aliases whose names were later reused. */
const copyAliasValue = (
  source: Node,
  context: AliasCopies,
  cloned?: Node,
): Node => {
  if (isAlias(source)) {
    const target = source.resolve(context.document);
    if (target === undefined)
      throw new TypeError("Cannot preserve an unresolved Hermes YAML alias");
    return copyAliasComments(source, copyAliasValue(target, context));
  }
  if (context.visiting.has(source))
    throw new TypeError("Cannot preserve cyclic Hermes YAML aliases");
  const retained = context.retained.get(source);
  if (
    retained !== undefined &&
    !isAlias(retained) &&
    retained.anchor !== undefined
  )
    return new Alias(retained.anchor);
  const copy = cloned ?? source.clone();
  if (!isNode(copy) || isAlias(copy))
    throw new TypeError("Invalid Hermes YAML value copy");
  if (source.anchor !== undefined) {
    let index = 1;
    let name = `${source.anchor}_rea_preserved`;
    while (context.names.has(name))
      name = `${source.anchor}_rea_preserved_${index++}`;
    context.names.add(name);
    copy.anchor = name;
    context.retained.set(source, copy);
  }
  context.visiting.add(source);
  const child = (value: unknown, copied: unknown): unknown =>
    isNode(value)
      ? copyAliasValue(value, context, isNode(copied) ? copied : undefined)
      : copied;
  if (isMap(source) && isMap(copy)) {
    for (const [index, pair] of source.items.entries()) {
      const copied = copy.items[index];
      if (copied === undefined) continue;
      copied.key = child(pair.key, copied.key);
      copied.value = child(pair.value, copied.value);
    }
  } else if (isSeq(source) && isSeq(copy)) {
    copy.items = source.items.map((value, index) =>
      child(value, copy.items[index]),
    );
  }
  context.visiting.delete(source);
  return copy;
};

/** Preserve other consumers before removing an anchored configuration value. */
export const preserveHermesAliasValues = (
  document: Document,
  previous: unknown,
): void => {
  if (!isNode(previous)) return;
  const removed = new Set<Node>();
  visit(previous, {
    Value: (_key, node) => {
      if (node.anchor !== undefined) removed.add(node);
    },
  });
  if (removed.size === 0) return;
  const context: AliasCopies = {
    document,
    retained: new Map(),
    visiting: new Set(),
    names: new Set(),
  };
  visit(document, {
    Value: (_key, node) => {
      if (node.anchor !== undefined) context.names.add(node.anchor);
    },
  });
  const replacements = new Map<Node, Node>();
  visit(document, {
    Alias: (_key, node, path) => {
      if (!path.includes(previous)) {
        const target = node.resolve(document);
        if (target === undefined || !removed.has(target)) return;
        replacements.set(
          node,
          copyAliasComments(node, copyAliasValue(target, context)),
        );
      }
    },
  });
  // Plan every copy against the original document before moving any anchor.
  visit(document, {
    Alias: (_key, node) => replacements.get(node),
  });
};
