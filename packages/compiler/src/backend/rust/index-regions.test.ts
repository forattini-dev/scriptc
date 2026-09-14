import { expect, test } from "vitest";
import type { IrExpr, IrFunction, IrModule, IrStmt } from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { emitRustModule } from "./emitter.js";
import { RustIndexRegionPlan } from "./index-regions.js";

const loc = { file: "index-regions.ts", start: 0, end: 1 };
const f64 = { kind: "f64" } as const;
const bytes = { kind: "bytes", elem: "u8" } as const;
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: f64, loc });
const ref = (localId: string): IrExpr => ({ kind: "varRef", localId, type: f64, loc });
const buffer = (localId: string): IrExpr => ({ kind: "varRef", localId, type: bytes, loc });
const bin = (op: "+" | "-" | "*" | "<", left: IrExpr, right: IrExpr): IrExpr =>
  ({ kind: "bin", op, left, right, type: op === "<" ? { kind: "bool" } : f64, loc });
function fixture() {
  const loop: Extract<IrStmt, { kind: "for" }> = {
    kind: "for", loc, init: { kind: "varDecl", localId: "i", init: num(0), loc },
    cond: bin("<", ref("i"), ref("count")),
    update: { kind: "assign", localId: "i", value: bin("+", ref("i"), num(1)), loc },
    body: [
      { kind: "varDecl", localId: "row", init: bin("*", ref("i"), num(4)), loc },
      { kind: "bytesSet", arr: buffer("out"), index: bin("+", ref("row"), num(1)), value: {
        kind: "bytesIntrinsic", receiver: buffer("input"), method: "get", args: [ref("i")], type: f64, loc,
      }, loc },
    ],
  };
  const fn: IrFunction = {
    name: "convert", params: [{ localId: "count", name: "count", type: f64 }, { localId: "input", name: "input", type: bytes }],
    locals: [
      ...["count", "i", "row"].map(id => ({ id, name: id, type: f64, mutable: id !== "row" })),
      ...["input", "out"].map(id => ({ id, name: id, type: bytes, mutable: false })),
    ], returnType: bytes, loc,
    body: [{ kind: "varDecl", localId: "out", init: { kind: "bytesNew", source: num(64), type: bytes, loc }, loc },
      loop, { kind: "return", value: buffer("out"), loc }],
  };
  const main: IrFunction = { name: "main", params: [], locals: [], body: [], returnType: { kind: "void" }, loc };
  const mod: IrModule = { irVersion: 8, sourceFile: loc.file, functions: [main, fn], entry: "main" };
  return { fn, loop, mod };
}

test("emission guards once and keeps counted loops and derived indices integer", () => {
  const { mod } = fixture();
  expect(validateModule(mod)).toEqual([]);
  const original = structuredClone(mod);
  const rust = emitRustModule(mod);
  expect(rust).toContain("let sc_index_sc_l_count: i64 = sc_l_count as i64;");
  expect(rust).toContain("let mut sc_index_sc_l_i: i64 = 0_i64;");
  expect(rust).toContain("let sc_index_sc_l_row: i64 = (sc_index_sc_l_i * 4_i64);");
  expect(rust).toContain("usize::try_from((sc_index_sc_l_row + 1_i64)).unwrap_or(usize::MAX)");
  expect(rust).toContain("while (sc_index_sc_l_i < sc_index_sc_l_count)");
  expect(rust).toContain("sc_index_sc_l_i += 1;");
  expect(rust).toContain("runtime::bytes_region_get_u8_integer(");
  expect(rust).toContain("runtime::bytes_region_set_u8_integer(");
  expect(rust).toContain("runtime::bytes_get("); // Backed or noninteger inputs.
  expect(rust.match(/\.fract\(\) == 0\.0/g)).toHaveLength(1);
  expect(rust.match(/runtime::bytes_with_mut_slice\(/g)).toHaveLength(2);
  expect(mod).toEqual(original);
  expect(emitRustModule(mod)).toBe(rust);
});

test("range proofs preserve overflow and negative zero semantics", () => {
  const { loop, fn } = fixture();
  const plan = RustIndexRegionPlan.build(loop, fn, () => false);
  expect(plan).not.toBeNull();
  expect(plan?.guard()).toContain("is_sign_negative()");
  expect(plan?.guard()).toContain("67108863.0");
  expect(plan?.number(bin("*", ref("i"), num(-1)))).toBeNull();
  expect(plan?.number(bin("*", ref("i"), num(Number.MAX_SAFE_INTEGER)))).toBeNull();
  expect(plan?.number(num(-0))).toBeNull();
  expect(plan?.number(num(Infinity))).toBeNull();
  expect(plan?.number(bin("-", ref("i"), num(4)))).not.toBeNull();
  expect(plan?.index(bin("-", ref("i"), num(4)))).toContain("usize::try_from");
});

test("written, captured, suspended and noncanonical bindings retain generic storage", () => {
  const { loop, fn } = fixture();
  expect(RustIndexRegionPlan.build(loop, fn, local => local.id === "count")).toBeNull();
  expect(RustIndexRegionPlan.build(loop, fn, local => local.id === "i")).toBeNull();
  loop.body.push({ kind: "assign", localId: "count", value: num(0), loc });
  expect(RustIndexRegionPlan.build(loop, fn, () => false)).toBeNull();
  loop.body.pop();
  loop.body.push({ kind: "assign", localId: "i", value: num(0.5), loc });
  expect(RustIndexRegionPlan.build(loop, fn, () => false)).toBeNull();
  loop.body.pop();
  fn.async = true;
  expect(RustIndexRegionPlan.build(loop, fn, () => false)).toBeNull();
  delete fn.async;
  loop.update = { kind: "assign", localId: "i", value: bin("+", ref("i"), num(2)), loc };
  expect(RustIndexRegionPlan.build(loop, fn, () => false)).toBeNull();
});

test("nested counted loops use one guarded region and exact signed row indices", () => {
  const { loop, fn, mod } = fixture();
  const inner = structuredClone(loop);
  const outerIndex = ref("y");
  fn.locals.push({ id: "y", name: "y", type: f64, mutable: true });
  loop.init = { kind: "varDecl", localId: "y", init: num(0), loc };
  loop.cond = bin("<", outerIndex, num(2));
  loop.update = { kind: "assign", localId: "y", value: bin("+", outerIndex, num(1)), loc };
  loop.body = [inner];
  const row = inner.body[0];
  if (row?.kind !== "varDecl") throw new Error("missing fixture row");
  row.init = bin("+", bin("*", outerIndex, num(16)), bin("*", ref("i"), num(4)));
  expect(validateModule(mod)).toEqual([]);
  const rust = emitRustModule(mod);
  expect(rust.match(/\.fract\(\) == 0\.0/g)).toHaveLength(1);
  expect(rust).toContain("sc_index_sc_l_y * 16_i64");
  expect(rust.match(/runtime::bytes_with_mut_slice\(/g)).toHaveLength(2);
});

test("for-of element bindings are not guarded or read before their scope", () => {
  const { loop, fn, mod } = fixture();
  const array = { kind: "array", elem: f64 } as const;
  fn.params.push({ localId: "items", name: "items", type: array });
  fn.locals.push({ id: "items", name: "items", type: array, mutable: false },
    { id: "item", name: "item", type: f64, mutable: false });
  const store = loop.body.pop();
  if (store?.kind !== "bytesSet") throw new Error("missing fixture store");
  store.index = bin("+", ref("row"), ref("item"));
  loop.body.push({ kind: "forOf", localId: "item", iterable: {
    kind: "varRef", localId: "items", type: array, loc,
  }, body: [store], loc });
  expect(validateModule(mod)).toEqual([]);
  const plan = RustIndexRegionPlan.build(loop, fn, () => false);
  expect(plan?.guard()).not.toContain("sc_l_item");
  expect(plan?.read("item")).toBeUndefined();
  const rust = emitRustModule(mod);
  expect(rust).not.toContain("sc_index_sc_l_item");
  expect(rust).toContain("let sc_l_item: f64 = runtime::array_get(");
});


test("immutable u8 reads carry their exact range into derived indices without hoisting reads", () => {
  const { loop, fn, mod } = fixture();
  const read: IrExpr = { kind: "bytesIntrinsic", receiver: buffer("input"), method: "get", args: [ref("i")], type: f64, loc };
  fn.locals.push({ id: "byte", name: "byte", type: f64, mutable: false });
  loop.body.unshift({ kind: "varDecl", localId: "byte", init: read, loc });
  const store = loop.body.at(-1);
  if (store?.kind !== "bytesSet") throw new Error("missing fixture store");
  store.index = bin("+", bin("*", ref("byte"), num(3)), num(2));
  expect(validateModule(mod)).toEqual([]);
  const plan = RustIndexRegionPlan.build(loop, fn, () => false);
  expect(plan?.locals.get("byte")).toEqual({ min: 0, max: 255 });
  expect(plan?.guard()).not.toContain("sc_l_byte");
  expect(plan?.number(store.index)).toBe("((sc_index_sc_l_byte * 3_i64) + 2_i64)");
  expect(plan?.number(bin("*", ref("byte"), num(-1)))).toBeNull();
  const rust = emitRustModule(mod);
  expect(rust).toContain("let sc_index_sc_l_byte: i64 = runtime::bytes_region_get_u8_integer(");
  expect(rust).toContain("usize::try_from(((sc_index_sc_l_byte * 3_i64) + 2_i64))");
  const declaration = fn.locals.find(local => local.id === "byte");
  if (!declaration) throw new Error("missing byte local");
  declaration.mutable = true;
  expect(RustIndexRegionPlan.build(loop, fn, () => false)?.read("byte")).toBeUndefined();
  declaration.mutable = false;
  read.receiver = { ...buffer("input"), type: { kind: "bytes", elem: "f64" } };
  expect(RustIndexRegionPlan.build(loop, fn, () => false)?.read("byte")).toBeUndefined();
});


test("byte stores retain integer values and evaluate checked reads before writes", () => {
  const { mod } = fixture();
  const rust = emitRustModule(mod);
  expect(rust).toContain("runtime::bytes_region_get_u8_integer(");
  expect(rust).toContain("runtime::bytes_region_set_u8_integer(");
  // A source read remains a distinct value evaluation before the checked store.
  expect(rust).toMatch(/let sc_rt_\d+ = runtime::bytes_region_get_u8_integer\([^;]+; runtime::bytes_region_set_u8_integer\(/);
  expect(rust).toContain("runtime::bytes_region_set(");
});

test("conditional bytes feed structurally proven integer calls and arithmetic stores", () => {
  const { fn, mod, loop } = fixture();
  const helper: IrFunction = { name: "distance", params: [{ localId: "value", name: "value", type: f64 }],
    locals: [{ id: "value", name: "value", type: f64, mutable: true }], returnType: f64, loc,
    body: [{ kind: "return", value: { kind: "libCall", fn: "math.abs", args: [bin("-", ref("value"), num(100))], type: f64, loc }, loc }] };
  mod.functions.push(helper);
  fn.locals.push({ id: "byte", name: "byte", type: f64, mutable: false });
  const read: IrExpr = { kind: "bytesIntrinsic", receiver: buffer("input"), method: "get", args: [ref("i")], type: f64, loc };
  loop.body.unshift({ kind: "varDecl", localId: "byte", init: {
    kind: "ternary", cond: bin("<", ref("i"), num(1)), then: num(0), else_: read, type: f64, loc,
  }, loc });
  const store = loop.body.at(-1);
  if (store?.kind !== "bytesSet") throw new Error("missing fixture store");
  store.value = bin("-", read, { kind: "call", callee: "distance", args: [ref("byte")], type: f64, loc });
  expect(validateModule(mod)).toEqual([]);
  const original = structuredClone(mod);
  const rust = emitRustModule(mod);
  expect(rust).toContain("let sc_index_sc_l_byte: i64 = (if");
  expect(rust).toContain("|sc_numeric_sc_l_value: i64| -> i64");
  expect(rust).toContain("runtime::bytes_region_set_u8_integer(");
  expect(rust).toContain("sc_f_distance(sc_l_byte)"); // Generic view/index fallback.
  expect(mod).toEqual(original);
  helper.body = [{ kind: "return", value: bin("*", ref("value"), num(-1)), loc }];
  expect(emitRustModule(mod)).not.toContain("|sc_numeric_sc_l_value: i64| -> i64");
});
