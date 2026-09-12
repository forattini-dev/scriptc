import { expect, test } from "vitest";
import type { IrExpr, IrFunction, IrModule, IrStmt } from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { emitRustModule } from "./emitter.js";
const loc = { file: "byte-regions.ts", start: 0, end: 1 };
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: { kind: "f64" }, loc });
const out: IrExpr = { kind: "varRef", localId: "out", type: { kind: "bytes", elem: "u8" }, loc };
function fixture(): { mod: IrModule; fn: IrFunction; loop: Extract<IrStmt, { kind: "for" }> } {
  const loop: Extract<IrStmt, { kind: "for" }> = { kind: "for", init: null, update: null,
    cond: { kind: "boolLit", value: false, type: { kind: "bool" }, loc }, loc,
    body: [{ kind: "bytesSet", arr: out, index: num(0), value: {
      kind: "bytesIntrinsic", receiver: out, method: "get", args: [num(1)], type: { kind: "f64" }, loc,
    }, loc }],
  };
  const fn: IrFunction = { name: "main", params: [], returnType: { kind: "void" }, loc,
    locals: [{ id: "out", name: "out", type: out.type, mutable: false }],
    body: [{ kind: "varDecl", localId: "out", init: { kind: "bytesNew", source: num(4), type: out.type, loc }, loc }, loop],
  };
  return { fn, loop, mod: { irVersion: 6, sourceFile: loc.file, entry: "main", functions: [fn] } };
}

test("fresh buffer loops borrow storage once and emit checked slice accesses", () => {
  const { mod } = fixture();
  expect(validateModule(mod)).toEqual([]);
  const original = structuredClone(mod);
  const rust = emitRustModule(mod);
  expect(rust).toContain("runtime::bytes_with_mut_slice(");
  expect(rust).toContain("runtime::bytes_region_get(");
  expect(rust).toContain("runtime::bytes_region_set(");
  expect(mod).toEqual(original);
});

test("escaping buffers and returns keep the ordinary loop", () => {
  const { mod, fn, loop } = fixture();
  loop.body.unshift({ kind: "exprStmt", expr: out, loc });
  expect(emitRustModule(mod)).not.toContain("runtime::bytes_with_mut_slice(");
  loop.body.shift();
  loop.body.push({ kind: "return", value: null, loc });
  expect(emitRustModule(mod)).not.toContain("runtime::bytes_with_mut_slice(");
  loop.body.pop();
  const local = fn.locals[0];
  if (!local) throw new Error("missing local");
  local.boxed = true;
  expect(emitRustModule(mod)).not.toContain("runtime::bytes_with_mut_slice(");
});

test("try dispatch does not cross a slice closure", () => {
  const { mod, loop } = fixture();
  const original = [...loop.body];
  loop.body = [{ kind: "tryCatch", tryBody: original, catchLocalId: null, catchBody: [], finallyBody: null, loc }];
  expect(validateModule(mod)).toEqual([]);
  expect(emitRustModule(mod)).not.toContain("runtime::bytes_with_mut_slice(");
});

test("nested regions reuse the outer slice instead of borrowing its storage again", () => {
  const { mod, fn, loop } = fixture();
  const scratch: IrExpr = { kind: "varRef", localId: "scratch", type: out.type, loc };
  fn.locals.push({ id: "scratch", name: "scratch", type: out.type, mutable: false });
  loop.body.push({ kind: "varDecl", localId: "scratch", init: {
    kind: "bytesNew", source: num(4), type: out.type, loc,
  }, loc }, { kind: "for", init: null, update: null, cond: loop.cond, loc, body: [
    { kind: "bytesSet", arr: scratch, index: num(0), value: {
      kind: "bytesIntrinsic", receiver: out, method: "get", args: [num(0)], type: { kind: "f64" }, loc,
    }, loc },
  ] });
  expect(validateModule(mod)).toEqual([]);
  const rust = emitRustModule(mod);
  expect(rust.match(/runtime::bytes_with_mut_slice\(/g)).toHaveLength(2);
  expect(rust).not.toContain("runtime::bytes_with_read_slice(");
});
