import { expect, test } from "vitest";
import type { IrExpr, IrModule } from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { emitRustModule } from "./emitter.js";
const loc = { file: "byte-store.ts", start: 0, end: 1 };
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: { kind: "f64" }, loc });
function fixture(elem: "u8" | "u32" | "f64", mask = 255): IrModule {
  const type = { kind: "bytes", elem } as const;
  const value: IrExpr = { kind: "varRef", localId: "value", type: { kind: "f64" }, loc };
  return { irVersion: 6, sourceFile: loc.file, entry: "main", functions: [{
    name: "main", params: [], returnType: { kind: "void" }, loc,
    locals: [{ id: "bytes", name: "bytes", type, mutable: false },
      { id: "value", name: "value", type: { kind: "f64" }, mutable: true }],
    body: [{ kind: "varDecl", localId: "bytes", init: { kind: "bytesNew", source: num(1), type, loc }, loc },
      { kind: "varDecl", localId: "value", init: num(-3), loc },
      { kind: "bytesSet", arr: { kind: "varRef", localId: "bytes", type, loc }, index: num(0), value: {
        kind: "bin", op: "&", left: value, right: num(mask), type: { kind: "f64" }, loc,
      }, loc }],
  }] };
}
test("u8 stores fold a redundant low-byte mask without changing shared IR", () => {
  const mod = fixture("u8");
  expect(validateModule(mod)).toEqual([]);
  const original = structuredClone(mod);
  expect(emitRustModule(mod)).not.toMatch(/let sc_rt_\d+ = runtime::bit_and\(/);
  expect(mod).toEqual(original);
});
test("wider stores and other masks retain their bit operation", () => {
  for (const mod of [fixture("u32"), fixture("f64"), fixture("u8", 127)]) {
    expect(validateModule(mod)).toEqual([]);
    expect(emitRustModule(mod)).toMatch(/let sc_rt_\d+ = runtime::bit_and\(/);
  }
});
