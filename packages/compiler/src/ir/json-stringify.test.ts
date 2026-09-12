import { expect, test } from "vitest";
import { UnionRegistry } from "../frontend/union-registry.js";
import { isJsonStringifyType } from "./json-stringify.js";
import { STRING, UNDEFINED_T, arrayOf, funcOf, isJsonSafeType, type IrType } from "./ir.js";

test("undefined array slots can encode without widening the JSON decoder domain", () => {
  const unions = new UnionRegistry();
  const optional: IrType = { kind: "union", unionId: unions.intern([STRING, UNDEFINED_T]) };
  const records = () => undefined;
  const union = (id: string) => unions.get(id);
  expect(isJsonStringifyType(arrayOf(optional), records, union)).toBe(true);
  expect(isJsonStringifyType(arrayOf(arrayOf(optional)), records, union)).toBe(true);
  expect(isJsonStringifyType(optional, records, union)).toBe(false);
  expect(isJsonSafeType(arrayOf(optional), records, union)).toBe(false);
  expect(isJsonStringifyType(arrayOf(funcOf([], STRING)), records, union)).toBe(false);
});
