import { expect, test } from "vitest";
import type { IrExpr, IrFunction, IrModule, IrStmt } from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { emitRustModule } from "./emitter.js";

const loc = { file: "byte-read-regions.ts", start: 0, end: 1 };
const scalar = { kind: "f64" } as const;
const bytes = { kind: "bytes", elem: "u8" } as const;
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: scalar, loc });
const ref = (localId: string): IrExpr => ({ kind: "varRef", localId, type: bytes, loc });
function fixture(): { mod: IrModule; loop: Extract<IrStmt, { kind: "for" }>; helper: IrFunction } {
  const helper: IrFunction = { name: "absolute", params: [{ localId: "x", name: "x", type: scalar }],
    locals: [{ id: "x", name: "x", type: scalar, mutable: false }], returnType: scalar, loc,
    body: [{ kind: "return", value: { kind: "libCall", fn: "math.abs", args: [
      { kind: "varRef", localId: "x", type: scalar, loc },
    ], type: scalar, loc }, loc }],
  };
  const loop: Extract<IrStmt, { kind: "for" }> = { kind: "for", init: null, update: null,
    cond: { kind: "boolLit", value: false, type: { kind: "bool" }, loc }, loc,
    body: [{ kind: "bytesSet", arr: ref("out"), index: num(0), value: {
      kind: "call", callee: helper.name, args: [{ kind: "bytesIntrinsic", receiver: ref("input"),
        method: "get", args: [num(0)], type: scalar, loc }], type: scalar, loc,
    }, loc }],
  };
  const fn: IrFunction = { name: "main", params: [], returnType: { kind: "void" }, loc,
    locals: ["input", "out"].map(id => ({ id, name: id, type: bytes, mutable: false })),
    body: ["input", "out"].map(localId => ({ kind: "varDecl", localId,
      init: { kind: "bytesNew", source: num(4), type: bytes, loc }, loc })),
  };
  fn.body.push(loop);
  return { mod: { irVersion: 8, sourceFile: loc.file, entry: "main", functions: [fn, helper] }, loop, helper };
}

test("read regions inspect direct callees and borrow stable inputs once", () => {
  const { mod } = fixture();
  expect(validateModule(mod)).toEqual([]);
  const original = structuredClone(mod);
  const rust = emitRustModule(mod);
  expect(rust).toContain("runtime::bytes_with_read_slice(");
  expect(rust).toContain("if let (Some(");
  expect(rust).not.toContain("runtime::bytes_read_region_get(");
  expect(rust).toContain("runtime::bytes_get(");
  expect(mod).toEqual(original);
});

test("multiple inputs select two loop versions rather than all combinations", () => {
  const { mod, loop } = fixture();
  const fn = mod.functions[0];
  const store = loop.body[0];
  if (!fn || store?.kind !== "bytesSet") throw new Error("missing fixture");
  fn.locals.push({ id: "other", name: "other", type: bytes, mutable: false });
  fn.body.unshift({ kind: "varDecl", localId: "other", init: { kind: "bytesNew", source: num(4), type: bytes, loc }, loc });
  store.value = { kind: "bin", op: "+", left: store.value, right: {
    kind: "bytesIntrinsic", receiver: ref("other"), method: "get", args: [num(0)], type: scalar, loc,
  }, type: scalar, loc };
  expect(validateModule(mod)).toEqual([]);
  const original = structuredClone(mod);
  const rust = emitRustModule(mod);
  expect(rust.match(/runtime::bytes_with_read_slice\(/g)).toHaveLength(2);
  expect(rust.match(/if let \(Some\(/g)).toHaveLength(1);
  expect(rust.match(/runtime::bytes_with_mut_slice\(/g)).toHaveLength(2);
  expect(rust).not.toContain("runtime::bytes_read_region_get(");
  expect(mod).toEqual(original);
});

test("writes through another buffer reject input borrowing but preserve output regions", () => {
  const { mod, loop } = fixture();
  loop.body.unshift({ kind: "bytesSet", arr: ref("input"), index: num(0), value: num(3), loc });
  expect(validateModule(mod)).toEqual([]);
  const rust = emitRustModule(mod);
  expect(rust).not.toContain("runtime::bytes_with_read_slice(");
  expect(rust).toContain("runtime::bytes_with_mut_slice(");
});

test("unknown effects and recursive callees retain ordinary reads", () => {
  const { mod, helper } = fixture();
  helper.body = [{ kind: "return", value: { kind: "libCall", fn: "math.random", args: [], type: scalar, loc }, loc }];
  expect(emitRustModule(mod)).not.toContain("runtime::bytes_with_read_slice(");
  helper.body = [{ kind: "return", value: { kind: "call", callee: helper.name, args: [num(1)], type: scalar, loc }, loc }];
  expect(emitRustModule(mod)).not.toContain("runtime::bytes_with_read_slice(");
});

test("a byte receiver declared inside the loop is not borrowed before its declaration", () => {
  const { mod, loop } = fixture();
  const fn = mod.functions[0];
  if (!fn) throw new Error("missing function");
  const input = fn.body.shift();
  if (!input) throw new Error("missing declaration");
  loop.body.unshift(input);
  expect(validateModule(mod)).toEqual([]);
  expect(emitRustModule(mod)).not.toContain("runtime::bytes_with_read_slice(");
});

test("buffer mutation in a direct callee rejects input borrowing", () => {
  const { mod, loop, helper } = fixture();
  helper.params = [{ localId: "input", name: "input", type: bytes }];
  helper.locals = [{ id: "input", name: "input", type: bytes, mutable: false }];
  helper.body = [{ kind: "bytesSet", arr: ref("input"), index: num(0), value: num(9), loc },
    { kind: "return", value: num(1), loc }];
  loop.body.unshift({ kind: "exprStmt", expr: { kind: "call", callee: helper.name,
    args: [ref("input")], type: scalar, loc }, loc });
  const store = loop.body[1];
  if (store?.kind !== "bytesSet") throw new Error("missing store");
  store.value = { kind: "bytesIntrinsic", receiver: ref("input"), method: "get", args: [num(0)], type: scalar, loc };
  expect(validateModule(mod)).toEqual([]);
  expect(emitRustModule(mod)).not.toContain("runtime::bytes_with_read_slice(");
});
