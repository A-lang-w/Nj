import * as t from "@babel/types";

import { semanticObjectPrototypeProperty } from "./javascriptAstValues.js";
import type { JavaScriptSemanticAnalysisState } from "./javascriptSemanticState.js";

/** Arrows inherit this and super; computed keys and decorators execute outside
 * the method or class whose declaration contains them. */
export const createSemanticLexicalReceiverOwner = (
  state: JavaScriptSemanticAnalysisState,
) => {
  const owners = new WeakMap<t.Node, t.Node>();
  return (node: t.Node): t.Node => {
    const visited: t.Node[] = [];
    let current = node;
    let owner: t.Node = state.program;
    for (;;) {
      const cached = owners.get(current);
      if (cached !== undefined) {
        owner = cached;
        break;
      }
      visited.push(current);
      let parent = state.parentsByNode.get(current);
      if (parent === undefined) break;
      if (t.isDecorator(current)) {
        while (
          parent !== undefined &&
          !t.isFunction(parent) &&
          !t.isClass(parent) &&
          !t.isClassProperty(parent) &&
          !t.isClassPrivateProperty(parent) &&
          !t.isClassAccessorProperty(parent)
        )
          parent = state.parentsByNode.get(parent);
        current = parent ?? state.program;
        continue;
      }
      if (
        (t.isFunction(parent) &&
          !t.isArrowFunctionExpression(parent) &&
          !(
            (t.isObjectMethod(parent) || t.isClassMethod(parent)) &&
            parent.computed &&
            parent.key === current
          )) ||
        t.isStaticBlock(parent) ||
        ((t.isClassProperty(parent) ||
          t.isClassPrivateProperty(parent) ||
          t.isClassAccessorProperty(parent)) &&
          parent.value === current)
      ) {
        owner = parent;
        break;
      }
      current = parent;
    }
    for (const visitedNode of visited) owners.set(visitedNode, owner);
    return owner;
  };
};

/** This is possible source lookup, never proof that a home's runtime prototype
 * is unchanged. The invocation keeps the lexical receiver independently. */
export const createSemanticSuperLookup = (
  state: JavaScriptSemanticAnalysisState,
) => {
  const lexicalOwner = createSemanticLexicalReceiverOwner(state);
  return (node: t.Super) => {
    const owner = lexicalOwner(node);
    const parent = state.parentsByNode.get(owner);
    if (t.isObjectMethod(owner) && t.isObjectExpression(parent)) {
      const prototype = semanticObjectPrototypeProperty(parent);
      return prototype === undefined
        ? undefined
        : { owner, home: parent, base: prototype.value, projection: [] };
    }
    const home =
      parent === undefined ? undefined : state.parentsByNode.get(parent);
    if (!t.isClass(home) || home.superClass == null) return undefined;
    const isStatic =
      t.isStaticBlock(owner) || ("static" in owner && owner.static);
    return {
      owner,
      home,
      base: home.superClass,
      projection: isStatic ? [] : ["prototype"],
    };
  };
};
