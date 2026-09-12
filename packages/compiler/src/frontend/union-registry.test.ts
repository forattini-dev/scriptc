import { expect, test } from "vitest";
import { type IrType, type IrUnionDef } from "../ir/ir.js";
import { UnionRegistry, withUndefinedArm } from "./type-mapper.js";

const arms: IrType[] = [{ kind: "record", shapeId: "a" }, { kind: "record", shapeId: "b" }];
const discriminant: IrUnionDef["discriminant"] = { field: "kind", cases: [
  { shapeId: "a", values: ["a"] }, { shapeId: "b", values: ["b"] },
] };

test("literal domains participate in union identity without altering legacy interning", () => {
  const unions = new UnionRegistry();
  const plain = unions.intern(arms);
  const tagged = unions.intern(arms, discriminant);
  expect(unions.intern(arms)).toBe(plain);
  expect(unions.intern(arms, structuredClone(discriminant))).toBe(tagged);
  expect(tagged).not.toBe(plain);
  expect(unions.intern(arms, { ...discriminant, field: "other" })).not.toBe(tagged);
});

test("adding undefined preserves discriminant domains and canonical identity", () => {
  const unions = new UnionRegistry();
  const value: IrType = { kind: "union", unionId: unions.intern(arms, discriminant) };
  const optional = withUndefinedArm(value, unions);
  expect(optional?.kind).toBe("union");
  if (optional?.kind !== "union") return;
  expect(unions.get(optional.unionId)?.discriminant).toEqual(discriminant);
  expect(unions.get(optional.unionId)?.arms).toEqual([...arms, { kind: "undefinedT" }]);
  expect(withUndefinedArm(optional, unions)).toEqual(optional);
});
