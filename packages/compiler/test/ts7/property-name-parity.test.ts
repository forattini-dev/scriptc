import { expect, test } from "vitest";
import { ad, buildTwoWorlds, ts5, walkBoth } from "./harness.js";

test("property lookup preserves isolated UTF-16 units and symbol identity", () => {
  const source = String.raw`import { foreignKey } from './keys.js';
  const localKey = '\ud802' as const;
  const alias = localKey;
  const keyed = {
    '\ud83d': 1, '\ude00': 2, '\ufffd': 3, '\ufffd\ufffd\ufffd': 4,
    '__\ud83d': 5, ['\ud800']: 6, '\ud83d\ude00': 7,
    [alias]: 8, [foreignKey]: 9,
  };`;
  const worlds = buildTwoWorlds({ "property-names.ts": source, "keys.ts": String.raw`export const foreignKey = '\ud803';` });
  try {
    const { n5, n7 } = walkBoth(worlds, worlds.files[0]!);
    const declaration5 = n5.filter(ts5.isVariableDeclaration).find((node) => node.name.getText() === "keyed")!;
    const declaration7 = n7.filter(ad.isVariableDeclaration).find((node) => node.name.getText() === "keyed")!;
    const type5 = worlds.c5.getTypeAtLocation(declaration5.name);
    const type7 = worlds.c7.getTypeAtLocation(declaration7.name);
    const expected = worlds.c5.getPropertiesOfType(type5).map((symbol) => symbol.name);
    // Lookup first: callers must not need to enumerate before asking for a key.
    const symbols = expected.map((name) => worlds.c7.getPropertyOfType(type7, name));
    expect(symbols.map((symbol) => symbol?.name)).toEqual(expected);
    expect(worlds.c7.getPropertiesOfType(type7)).toEqual(symbols);
    expect(new Set(symbols).size).toBe(expected.length);
    for (const [index, name] of expected.entries()) {
      expect(worlds.c7.getPropertyOfType(type7, name)).toBe(symbols[index]);
    }
    expect(worlds.c7.getPropertyOfType(type7, "\ud801")).toBeUndefined();
    const local5 = n5.filter(ts5.isVariableDeclaration).find((node) => node.name.getText() === "localKey")!;
    const local7 = n7.filter(ad.isVariableDeclaration).find((node) => node.name.getText() === "localKey")!;
    const literal5 = worlds.c5.getTypeAtLocation(local5.name);
    const literal7 = worlds.c7.getTypeAtLocation(local7.name);
    if (!literal5.isStringLiteral() || !literal7.isStringLiteralType()) throw new Error("literal type missing");
    expect(literal7.value).toBe(literal5.value);
  } finally {
    worlds.dispose();
  }
});

test("declared string literal property types retain their UTF-16 values", () => {
  const worlds = buildTwoWorlds({ "literal-types.ts": String.raw`
    type High = '\ud805';
    interface Labels { high: High; low: '\ud806' }
    declare const labels: Labels;
  ` });
  try {
    const { n5, n7 } = walkBoth(worlds, worlds.files[0]!);
    const node5 = n5.find(ts5.isVariableDeclaration)!;
    const node7 = n7.find(ad.isVariableDeclaration)!;
    const props5 = worlds.c5.getPropertiesOfType(worlds.c5.getTypeAtLocation(node5.name));
    const props7 = worlds.c7.getPropertiesOfType(worlds.c7.getTypeAtLocation(node7.name));
    const values5 = props5.map((symbol) => {
      const type = worlds.c5.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration!);
      return type.isStringLiteral() ? type.value : undefined;
    });
    const values7 = props7.map((symbol) => {
      const type = worlds.c7.getTypeOfSymbol(symbol);
      return type.isStringLiteralType() ? type.value : undefined;
    });
    expect(values7).toEqual(values5);
  } finally {
    worlds.dispose();
  }
});
