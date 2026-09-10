import { expect, test } from "vitest";
import type { IrExpr, IrFunction, IrModule } from "../../ir/nodes.js";
import { validateModule } from "../../ir/validate.js";
import { mangleLocal } from "../mangle.js";
import { emitRustModule } from "./emitter.js";
import { borrowedRustBytesLocal } from "./bytes-borrow.js";

const loc = { file: "bytes-borrow.ts", start: 0, end: 1 };
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: { kind: "f64" }, loc });
const bytes: IrExpr = { kind: "varRef", localId: "bytes", type: { kind: "bytes", elem: "u8" }, loc };
const index: IrExpr = { kind: "varRef", localId: "index", type: { kind: "f64" }, loc };
function fixture(): IrModule {
  const fn: IrFunction = {
    name: "main", params: [], returnType: { kind: "void" }, loc,
    locals: [
      { id: "bytes", name: "bytes", type: bytes.type, mutable: true },
      { id: "index", name: "index", type: index.type, mutable: true },
    ],
    body: [
      { kind: "varDecl", localId: "bytes", init: { kind: "bytesNew", source: num(4), type: bytes.type, loc }, loc },
      { kind: "varDecl", localId: "index", init: num(0), loc },
      { kind: "exprStmt", expr: { kind: "bytesIntrinsic", method: "get", receiver: bytes, args: [index], type: { kind: "f64" }, loc }, loc },
      { kind: "exprStmt", expr: { kind: "bytesIntrinsic", method: "length", receiver: bytes, args: [], type: { kind: "f64" }, loc }, loc },
    ],
  };
  return { irVersion: 6, sourceFile: loc.file, entry: fn.name, functions: [fn] };
}

test("byte reads and length borrow an eligible local without cloning its handle", () => {
  const mod = fixture();
  expect(validateModule(mod)).toEqual([]);
  const original = structuredClone(mod);
  const rust = emitRustModule(mod);
  expect(rust).toContain(`runtime::bytes_get(&(${mangleLocal("bytes")}),`);
  expect(rust).toContain(`runtime::bytes_len(&(${mangleLocal("bytes")}))`);
  expect(mod).toEqual(original);
});

function mainFunction(mod: IrModule): IrFunction {
  const fn = mod.functions[0];
  if (fn === undefined) throw new Error("missing main fixture");
  return fn;
}

test("an index call retains the owned receiver snapshot", () => {
  const mod = fixture();
  const fn = mainFunction(mod);
  const read = fn.body[2];
  if (read?.kind !== "exprStmt" || read.expr.kind !== "bytesIntrinsic") throw new Error("missing read fixture");
  read.expr.args = [{ kind: "call", callee: "indexCall", args: [], type: { kind: "f64" }, loc }];
  mod.functions.push({ name: "indexCall", params: [], locals: [], returnType: { kind: "f64" }, loc,
    body: [{ kind: "return", value: num(0), loc }],
  });
  expect(validateModule(mod)).toEqual([]);
  const rust = emitRustModule(mod);
  expect(rust).toContain(`runtime::bytes_get(&(${mangleLocal("bytes")}.clone()),`);
});


test("borrowing rejects boxed, forced-boxed, global and suspended receivers", () => {
  const fn = mainFunction(fixture());
  let current: IrFunction | null = fn;
  let forceBoxed = false;
  const context = { currentFunction: () => current, localIsBoxed: (local: IrFunction["locals"][number]) => forceBoxed || local.boxed === true };
  expect(borrowedRustBytesLocal(bytes, [index], context)).toBe(mangleLocal("bytes"));
  forceBoxed = true;
  expect(borrowedRustBytesLocal(bytes, [index], context)).toBeNull();
  forceBoxed = false;
  const local = fn.locals[0];
  if (local === undefined) throw new Error("missing buffer fixture");
  local.boxed = true;
  expect(borrowedRustBytesLocal(bytes, [index], context)).toBeNull();
  delete local.boxed;
  fn.async = true;
  expect(borrowedRustBytesLocal(bytes, [index], context)).toBeNull();
  delete fn.async;
  fn.generator = { yieldT: { kind: "f64" }, nextT: { kind: "undefinedT" } };
  expect(borrowedRustBytesLocal(bytes, [index], context)).toBeNull();
  delete fn.generator;
  const global: IrExpr = { ...bytes, localId: "globalBytes" };
  expect(borrowedRustBytesLocal(global, [], context)).toBeNull();
  current = null;
  expect(borrowedRustBytesLocal(bytes, [index], context)).toBeNull();
});

test("borrowing allows numeric increments and nested reads but refuses receiver assignments", () => {
  const fn = mainFunction(fixture());
  const context = { currentFunction: () => fn, localIsBoxed: () => false };
  const increment: IrExpr = { kind: "incDec", localId: "index", op: "+", prefix: false, type: { kind: "f64" }, loc };
  const nested: IrExpr = { kind: "bytesIntrinsic", receiver: bytes, method: "get", args: [increment], type: { kind: "f64" }, loc };
  expect(borrowedRustBytesLocal(bytes, [nested], context)).toBe(mangleLocal("bytes"));
  const changed: IrExpr = { kind: "seqExpr", stmts: [{ kind: "assign", localId: "bytes", value: {
    kind: "bytesNew", source: num(3), type: bytes.type, loc,
  }, loc }], result: num(0), type: { kind: "f64" }, loc };
  expect(borrowedRustBytesLocal(bytes, [changed], context)).toBeNull();
  let deep: IrExpr = index;
  for (let i = 0; i < 70; i++) deep = { kind: "bin", op: "+", left: deep, right: num(1), type: { kind: "f64" }, loc };
  expect(borrowedRustBytesLocal(bytes, [deep], context)).toBeNull();
});

test("byte writes borrow a stable receiver through index and value evaluation", () => {
  const mod = fixture();
  const fn = mainFunction(mod);
  fn.body.push({ kind: "bytesSet", arr: bytes, index, value: {
    kind: "bytesIntrinsic", receiver: bytes, method: "get", args: [index], type: { kind: "f64" }, loc,
  }, loc });
  expect(validateModule(mod)).toEqual([]);
  const original = structuredClone(mod);
  const rust = emitRustModule(mod);
  expect(rust).toMatch(new RegExp(`let sc_rt_\\d+ = &${mangleLocal("bytes")};`));
  expect(rust).not.toContain(`${mangleLocal("bytes")}.clone()`);
  expect(mod).toEqual(original);
});

test.each(["index", "value"] as const)("byte write %s replacement retains the original receiver snapshot", (position) => {
  const mod = fixture();
  const fn = mainFunction(mod);
  const replacement: IrExpr = { kind: "seqExpr", stmts: [{ kind: "assign", localId: "bytes", value: {
    kind: "bytesNew", source: num(2), type: bytes.type, loc,
  }, loc }], result: num(0), type: { kind: "f64" }, loc };
  fn.body.push({ kind: "bytesSet", arr: bytes, index: position === "index" ? replacement : index,
    value: position === "value" ? replacement : num(7), loc });
  expect(validateModule(mod)).toEqual([]);
  const rust = emitRustModule(mod);
  expect(rust).toMatch(new RegExp(`let sc_rt_\\d+ = ${mangleLocal("bytes")}\\.clone\\(\\);`));
  expect(rust).not.toMatch(new RegExp(`let sc_rt_\\d+ = &${mangleLocal("bytes")};`));
});

test.each(["index", "value"] as const)("byte write %s calls retain an owned receiver", (position) => {
  const mod = fixture();
  const fn = mainFunction(mod);
  const call: IrExpr = { kind: "call", callee: "compute", args: [], type: { kind: "f64" }, loc };
  mod.functions.push({ name: "compute", params: [], locals: [], returnType: { kind: "f64" }, loc,
    body: [{ kind: "return", value: num(0), loc }],
  });
  fn.body.push({ kind: "bytesSet", arr: bytes, index: position === "index" ? call : index,
    value: position === "value" ? call : num(7), loc });
  expect(validateModule(mod)).toEqual([]);
  expect(emitRustModule(mod)).toMatch(new RegExp(`let sc_rt_\\d+ = ${mangleLocal("bytes")}\\.clone\\(\\);`));
});
