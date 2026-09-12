import { expect, test } from "vitest";
import { UnionRegistry } from "../frontend/union-registry.js";
import { NULL_T, STRING, arrayOf, type IrType } from "./ir.js";
import { regexCaptureArray, regexCaptureLayout } from "./regex-captures.js";

test("regex result ABI retains distinct participating and absent capture tags", () => {
  const unions = new UnionRegistry();
  const row = regexCaptureArray(unions);
  const match: IrType = { kind: "union", unionId: unions.intern([row, NULL_T]) };
  const get = (id: string) => unions.get(id);
  const layout = regexCaptureLayout(match, get);
  expect(layout).not.toBeNull();
  expect(layout?.stringTag).not.toBe(layout?.undefinedTag);
  expect(regexCaptureLayout(arrayOf(row), get)).toEqual(layout);
  expect(regexCaptureLayout(arrayOf(arrayOf(STRING)), get)).toBeNull();
});
