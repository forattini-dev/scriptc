import { expect, test } from "vitest";
import { canConvertToDyn, type IrType } from "./ir.js";

test.each(["f32", "f64"] as const)("floating %s bytes box through owning composites", elem => {
  const bytes: IrType = { kind: "bytes", elem };
  const record = { id: "samples", fields: [{ name: "data", type: bytes }] };
  const union = { id: "optional", arms: [bytes, { kind: "undefinedT" } as const] };
  const getRecord = (id: string) => id === record.id ? record : undefined;
  const getUnion = (id: string) => id === union.id ? union : undefined;
  for (const type of [bytes, { kind: "array", elem: bytes }, { kind: "record", shapeId: record.id }, { kind: "union", unionId: union.id }] as IrType[]) {
    expect(canConvertToDyn(type, getRecord, getUnion)).toBe(true);
  }
});

test("integer typed array boxing remains outside this migration", () => {
  for (const elem of ["u32", "i32"] as const) {
    expect(canConvertToDyn({ kind: "bytes", elem }, () => undefined, () => undefined)).toBe(false);
  }
});
