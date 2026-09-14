import { expect, test } from "vitest";
import type { IrExpr, IrFunction, IrModule, IrStmt } from "../../ir/ir.js";
import { emitRustModule } from "./emitter.js";
import { validateModule } from "../../ir/validate.js";
import { RustIntegerLoops } from "./integer-loops.js";

const loc = { file: "integer-loops.ts", start: 0, end: 1 };
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: { kind: "f64" }, loc });
const index: IrExpr = { kind: "varRef", localId: "i", type: { kind: "f64" }, loc };
const bytes: IrExpr = { kind: "varRef", localId: "bytes", type: { kind: "bytes", elem: "u8" }, loc };
function fixture(): { fn: IrFunction; loop: Extract<IrStmt, { kind: "for" }> } {
  const loop: Extract<IrStmt, { kind: "for" }> = {
    kind: "for", loc,
    init: { kind: "varDecl", localId: "i", init: num(0), loc },
    cond: { kind: "bin", op: "<", left: index, right: {
      kind: "bytesIntrinsic", receiver: bytes, method: "length", args: [], type: { kind: "f64" }, loc,
    }, type: { kind: "bool" }, loc },
    update: { kind: "assign", localId: "i", value: {
      kind: "bin", op: "+", left: index, right: num(1), type: { kind: "f64" }, loc,
    }, loc },
    body: [],
  };
  return { loop, fn: {
    name: "sum", params: [], returnType: { kind: "void" }, loc, body: [loop],
    locals: [
      { id: "i", name: "i", type: { kind: "f64" }, mutable: true },
      { id: "bytes", name: "bytes", type: bytes.type, mutable: true },
    ],
  } };
}

test("integer storage is scoped to the function and active loop", () => {
  const { fn, loop } = fixture();
  let current: IrFunction | null = fn;
  const model = new RustIntegerLoops(() => current);
  expect(model.match(loop, () => false)?.localId).toBe("i");
  model.bind("i", "index0");
  expect(model.index(index)).toBe("index0");
  expect(model.index(num(0))).toBeUndefined();
  current = fixture().fn; // Same local id in a different function.
  expect(model.index(index)).toBeUndefined();
  current = fn;
  expect(model.index(index)).toBe("index0");
  model.unbind("i");
  expect(model.index(index)).toBeUndefined();
  current = null;
  expect(model.match(loop, () => false)).toBeNull();
});

test("integer storage refuses captured, forced-boxed, async and generator bindings", () => {
  const { fn, loop } = fixture();
  const model = new RustIntegerLoops(() => fn);
  expect(model.match(loop, local => local.id === "i")).toBeNull();
  expect(model.match(loop, local => local.id === "bytes")).toBeNull();
  const counter = fn.locals[0];
  if (counter === undefined) throw new Error("missing fixture counter");
  counter.boxed = true;
  expect(model.match(loop, () => false)).toBeNull();
  delete counter.boxed;
  fn.async = true;
  expect(model.match(loop, () => false)).toBeNull();
  delete fn.async;
  fn.generator = { yieldT: { kind: "f64" }, nextT: { kind: "undefinedT" }, resultType: { kind: "record", shapeId: "r0" } };
  expect(model.match(loop, () => false)).toBeNull();
});

test("integer storage refuses body writes and noncanonical updates", () => {
  const { fn, loop } = fixture();
  const model = new RustIntegerLoops(() => fn);
  loop.body.push({ kind: "assign", localId: "i", value: num(0.5), loc });
  expect(model.match(loop, () => false)).toBeNull();
  loop.body.length = 0;
  loop.update = { kind: "assign", localId: "i", value: num(4), loc };
  expect(model.match(loop, () => false)).toBeNull();
});


test("emission uses checked integer byte operations and leaves the shared IR unchanged", () => {
  const { fn, loop } = fixture();
  fn.body.unshift({ kind: "varDecl", localId: "bytes", loc, init: {
    kind: "bytesNew", source: num(4), type: bytes.type, loc,
  } });
  loop.body.push({ kind: "bytesSet", arr: bytes, index, loc, value: {
    kind: "bytesIntrinsic", receiver: bytes, method: "get", args: [index], type: { kind: "f64" }, loc,
  } });
  const mod: IrModule = { irVersion: 8, sourceFile: loc.file, entry: fn.name, functions: [fn] };
  expect(validateModule(mod)).toEqual([]);
  const original = structuredClone(mod);
  const rust = emitRustModule(mod);
  expect(rust).toContain(": usize = 0; // integer induction");
  expect(rust).toContain("runtime::bytes_len_usize(");
  expect(rust).toContain("runtime::bytes_get_usize(");
  expect(rust).toContain("runtime::bytes_set_usize(");
  expect(mod).toEqual(original);
  expect(emitRustModule(mod)).toBe(rust);
  loop.body.unshift({ kind: "assign", localId: "i", value: num(0.5), loc });
  const generic = emitRustModule(mod);
  expect(generic).not.toContain("integer induction");
  expect(generic).toContain("runtime::bytes_get(");
});
