import { expect, test } from "vitest";
import { DYN, RUNTIME_ERROR_CLASSES, canConvertToDyn, type IrType } from "./ir.js";

test("native runtime Error subclasses cross dynamic Promise and callback boundaries", () => {
  const record = () => undefined;
  const union = () => undefined;
  for (const className of RUNTIME_ERROR_CLASSES.keys()) {
    const error: IrType = { kind: "object", className };
    expect(canConvertToDyn(error, record, union), className).toBe(true);
    expect(canConvertToDyn({ kind: "promise", inner: error }, record, union), className).toBe(true);
    expect(canConvertToDyn({ kind: "func", params: [DYN], ret: error }, record, union), className).toBe(true);
  }
});
