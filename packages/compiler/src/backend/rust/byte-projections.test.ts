import { expect, test } from "vitest";
import type { IrExpr, IrFunction, IrModule, IrStmt } from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { emitRustModule } from "./emitter.js";
import { rustByteProjection } from "./byte-projections.js";

const loc = { file: "byte-projections.ts", start: 0, end: 1 };
const scalar = { kind: "f64" } as const;
const bytes = { kind: "bytes", elem: "u8" } as const;
const union = { kind: "union", unionId: "optional" } as const;
const bool = { kind: "bool" } as const;
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: scalar, loc });
const source: IrExpr = { kind: "varRef", localId: "source", type: union, loc };
function fixture() {
  const parameter: IrExpr = { kind: "varRef", localId: "value", type: union, loc };
  const helper: IrFunction = { name: "extract", params: [{ localId: "value", name: "value", type: union }],
    locals: [{ id: "value", name: "value", type: union, mutable: true }], returnType: bytes, loc,
    body: [{ kind: "if", cond: { kind: "unionIsTag", unionId: union.unionId, tag: 1, value: parameter, negated: false, type: bool, loc },
      then: [{ kind: "throw", value: { kind: "libCall", fn: "error.new", args: [
        { kind: "strLit", value: "missing bytes", type: { kind: "string" }, loc },
      ], type: { kind: "object", className: "%TypeError" }, loc }, loc }], else_: null, loc },
    { kind: "return", value: { kind: "unionNarrow", unionId: union.unionId, tag: 0, value: parameter, type: bytes, loc }, loc }],
  };
  const receiver: IrExpr = { kind: "call", callee: helper.name, args: [source], type: bytes, loc };
  const out: IrExpr = { kind: "varRef", localId: "out", type: bytes, loc };
  const loop: Extract<IrStmt, { kind: "for" }> = { kind: "for", init: null, update: null, loc,
    cond: { kind: "boolLit", value: false, type: bool, loc }, body: [{ kind: "bytesSet", arr: out, index: num(0),
      value: { kind: "bytesIntrinsic", receiver, method: "get", args: [num(0)], type: scalar, loc }, loc }],
  };
  const fn: IrFunction = { name: "copy", params: [{ localId: "source", name: "source", type: union }],
    locals: [{ id: "source", name: "source", type: union, mutable: true }, { id: "out", name: "out", type: bytes, mutable: false }],
    returnType: bytes, loc, body: [{ kind: "varDecl", localId: "out", init: { kind: "bytesNew", source: num(4), type: bytes, loc }, loc },
      loop, { kind: "return", value: out, loc }],
  };
  const main: IrFunction = { name: "main", params: [], locals: [], body: [], returnType: { kind: "void" }, loc };
  const mod: IrModule = { irVersion: 6, sourceFile: loc.file, entry: main.name, functions: [main, fn, helper],
    unions: [{ id: union.unionId, arms: [bytes, { kind: "nullT" }] }] };
  return { helper, receiver, fn, loop, mod };
}

test("nullable byte projections select a slice once without hoisting the failure", () => {
  const { mod } = fixture();
  expect(validateModule(mod)).toEqual([]);
  const original = structuredClone(mod);
  const rust = emitRustModule(mod);
  expect(rust).toContain("runtime::bytes_with_optional_read_slice(");
  expect(rust).toContain("runtime::bytes_region_get(");
  expect(rust).toContain("runtime::bytes_get(&(sc_f_extract(");
  expect(rust.match(/runtime::bytes_with_mut_slice\(/g)).toHaveLength(2);
  expect(mod).toEqual(original);
  expect(emitRustModule(mod)).toBe(rust);
});

test("projection recognition proves the successful path instead of trusting helper names", () => {
  const { receiver, helper } = fixture();
  const functions = new Map([[helper.name, helper]]);
  expect(rustByteProjection(receiver, functions)?.localId).toBe("source");
  helper.body.unshift({ kind: "exprStmt", expr: { kind: "libCall", fn: "math.random", args: [], type: scalar, loc }, loc });
  expect(rustByteProjection(receiver, functions)).toBeNull();
  helper.body.shift();
  const guard = helper.body[0];
  if (guard?.kind !== "if" || guard.cond.kind !== "unionIsTag") throw new Error("missing fixture guard");
  guard.cond.tag = 0; // Now the throw executes on the projected arm.
  expect(rustByteProjection(receiver, functions)).toBeNull();
  guard.cond.negated = true;
  expect(rustByteProjection(receiver, functions)).not.toBeNull();
  helper.async = true;
  expect(rustByteProjection(receiver, functions)).toBeNull();
});

test("written union parameters retain ordinary reads", () => {
  const { fn, loop, mod } = fixture();
  loop.body.push({ kind: "assign", localId: "source", value: source, loc });
  expect(emitRustModule(mod)).not.toContain("runtime::bytes_with_optional_read_slice(");
  loop.body.pop();
  const local = fn.locals.find(local => local.id === "source");
  if (!local) throw new Error("missing fixture local");
  local.boxed = true;
  expect(emitRustModule(mod)).not.toContain("runtime::bytes_with_optional_read_slice(");
});


test("missing projections preserve the existing direct input fast path", () => {
  const { mod, fn, loop } = fixture();
  fn.params.push({ localId: "direct", name: "direct", type: bytes });
  fn.locals.push({ id: "direct", name: "direct", type: bytes, mutable: false });
  const store = loop.body[0];
  if (store?.kind !== "bytesSet") throw new Error("missing store");
  store.value = { kind: "bin", op: "+", left: store.value, right: {
    kind: "bytesIntrinsic", receiver: { kind: "varRef", localId: "direct", type: bytes, loc },
    method: "get", args: [num(0)], type: scalar, loc,
  }, type: scalar, loc };
  expect(validateModule(mod)).toEqual([]);
  const rust = emitRustModule(mod);
  expect(rust.match(/runtime::bytes_with_mut_slice\(/g)).toHaveLength(3);
  expect(rust.match(/if let \(Some\(/g)).toHaveLength(2);
  // Both specialized paths read the direct source through its slice.
  expect(rust.match(/runtime::bytes_region_get\(/g)).toHaveLength(3);
});
