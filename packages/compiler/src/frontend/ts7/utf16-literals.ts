import type { Node } from "typescript/unstable/ast";
import type { Symbol, Type } from "typescript/unstable/sync";
import {
  isAsExpression, isComputedPropertyName, isIdentifier,
  isParenthesizedExpression, isPropertyAccessExpression, isStringLiteralLike,
} from "./ast.js";
import { SyntaxKind } from "./enums.js";

/** Unicode-mode matching skips paired surrogates, which form one code point. */
export function hasUnpairedSurrogate(value: string): boolean {
  return /[\uD800-\uDFFF]/u.test(value);
}

/** tsgo's JSON transport replaces WTF-8 symbol names with U+FFFD. The
 * client AST retains the original literal's UTF-16 units. Repair the cached
 * symbol itself so declarations, enumeration and lookup keep one identity.
 * Ordinary names never pay for declaration resolution. */
export class Utf16Literals {
  private readonly checked = new WeakSet<Symbol>();
  private readonly restoredTypes = new WeakSet<Type>();
  constructor(
    private readonly declarations: (symbol: Symbol) => readonly Node[],
    private readonly symbolAtLocation: (node: Node) => Symbol | undefined,
  ) {}

  private literalText(node: Node, seen = new Set<Node>()): string | undefined {
    if (seen.has(node)) return undefined;
    seen.add(node);
    if (isStringLiteralLike(node)) return node.text;
    if (isAsExpression(node)) return this.literalText(node.type, seen) ?? this.literalText(node.expression, seen);
    if (isParenthesizedExpression(node)) return this.literalText(node.expression, seen);
    if (node.kind === SyntaxKind.LiteralType && "literal" in node) return this.literalText(node.literal as Node, seen);
    if (node.kind === SyntaxKind.TypeReference && "typeName" in node) return this.literalText(node.typeName as Node, seen);
    if (isIdentifier(node) || isPropertyAccessExpression(node)) {
      const symbol = this.symbolAtLocation(isPropertyAccessExpression(node) ? node.name : node);
      if (symbol === undefined) return undefined;
      for (const declaration of this.declarations(symbol)) {
        const text = this.literalText(declaration, seen);
        if (text !== undefined) return text;
      }
    }
    for (const field of ["type", "initializer"] as const) {
      if (!(field in node)) continue;
      const child = (node as Node & { type?: Node; initializer?: Node })[field];
      if (child !== undefined) {
        const text = this.literalText(child, seen);
        if (text !== undefined) return text;
      }
    }
    return undefined;
  }

  restoreType(type: Type | undefined, node: Node): Type | undefined {
    if (!type?.isStringLiteralType() || !type.value.includes("\uFFFD") || this.restoredTypes.has(type)) return type;
    const text = this.literalText(node);
    if (text === undefined || !hasUnpairedSurrogate(text)) return type;
    for (const related of [type, type.getRegularType(), type.getFreshType()]) {
      if (related?.isStringLiteralType()) {
        Object.defineProperty(related, "value", { value: text });
        this.restoredTypes.add(related);
      }
    }
    return type;
  }

  restoreSymbolType(type: Type | undefined, symbol: Symbol): Type | undefined {
    if (!type?.isStringLiteralType() || !type.value.includes("\uFFFD") || this.restoredTypes.has(type)) return type;
    for (const declaration of this.declarations(symbol)) this.restoreType(type, declaration);
    return type;
  }

  restore(symbol: Symbol): Symbol;
  restore(symbol: Symbol | undefined): Symbol | undefined;
  restore(symbol: Symbol | undefined): Symbol | undefined {
    if (symbol === undefined || !symbol.name.includes("\uFFFD") || this.checked.has(symbol)) return symbol;
    this.checked.add(symbol);
    for (const declaration of this.declarations(symbol)) {
      if (!("name" in declaration)) continue;
      const name = declaration.name as Node | undefined;
      if (name === undefined) continue;
      const text = this.literalText(isComputedPropertyName(name) ? name.expression : name);
      if (text !== undefined && hasUnpairedSurrogate(text)) {
        Object.defineProperty(symbol, "name", { value: text });
        break;
      }
    }
    return symbol;
  }
}
