import { expect, test } from "vitest";
import { nativeTupleElement } from "./native-tuple.js";
import { nativeRecordCheckSupported } from "./native-record.js";
import { DYN, F64, STRING, type IrRecordShape, type IrType } from "./ir.js";
const tuple = (types: IrType[]): IrRecordShape => ({ id: "tuple", tuple: true, fields: types.map((type, index) => ({ name: String(index), type })) });

test.each([F64, STRING, DYN])("homogeneous dense scalar tuples have a shared array element: %j", element => {
  const shape = tuple([element, element]);
  expect(nativeTupleElement(shape)).toEqual(element);
  expect(nativeRecordCheckSupported({ kind: "record", shapeId: shape.id }, () => shape, () => undefined)).toBe(true);
});

test("heterogeneous, sparse, empty and composite tuples retain their fence", () => {
  expect(nativeTupleElement(tuple([]))).toBeUndefined();
  expect(nativeTupleElement(tuple([STRING, F64]))).toBeUndefined();
  expect(nativeTupleElement(tuple([{ kind: "array", elem: STRING }]))).toBeUndefined();
  expect(nativeTupleElement({ id: "record", fields: [{ name: "0", type: STRING }] })).toBeUndefined();
  expect(nativeTupleElement({ id: "hole", tuple: true, fields: [{ name: "1", type: STRING }] })).toBeUndefined();
});
