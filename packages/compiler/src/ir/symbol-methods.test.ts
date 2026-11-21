import { expect, test } from "vitest";
import { BOOL, DYN, VOID, type IrClassDef, type IrExpr, type IrModule, type IrType } from "./ir.js";
import { containsSymbolMethods, validateSymbolMethods } from "./symbol-methods.js";
import { validateModule } from "./validate.js";

const loc = { file: "symbol-methods.ts", start: 0, end: 0 };
function moduleFor(): IrModule {
  return { irVersion: 13, sourceFile: loc.file, entry: "main", classes: [{ name: "Box", fields: [], symbolMethods: [{ key: "iterator" }], loc }],
    functions: [{ name: "main", params: [], locals: [], returnType: VOID, body: [], loc }] };
}

test("iteration-symbol descriptors retain undemanded bodies separately from string names", () => {
  const mod = moduleFor();
  const cls = mod.classes![0]!;
  cls.methodNames = ["iterator", "Symbol.iterator"];
  cls.symbolMethods!.push({ key: "asyncIterator" });
  expect(validateModule(mod)).toEqual([]);
  expect(mod.functions).toHaveLength(1);
});

test("symbol descriptors reject duplicate keys, unknown keys, and runtime declarations", () => {
  for (const descriptor of [{ key: "iterator" }, { key: "toPrimitive" }, { key: "constructor" }, { key: "__proto__" }, { key: "unique:0" }, { key: "unique:01" }, { key: "unique:4294967296" }]) {
    const mod = moduleFor();
    mod.classes![0]!.symbolMethods!.push(descriptor as NonNullable<IrClassDef["symbolMethods"]>[number]);
    expect(validateModule(mod).some(error => error.message.includes("symbol method surface"))).toBe(true);
  }
  const mod = moduleFor();
  mod.classes![0]!.runtime = true;
  expect(validateSymbolMethods(mod)).not.toEqual([]);
});

test("unique source symbols retain distinct descriptor identities", () => {
  const mod = moduleFor();
  mod.classes![0]!.symbolMethods!.push({ key: "unique:7" }, { key: "unique:8" });
  expect(validateModule(mod)).toEqual([]);
  mod.classes![0]!.symbolMethods!.push({ key: "unique:7" });
  expect(validateSymbolMethods(mod).some(error => error.message.includes("symbol method surface"))).toBe(true);
});

test("a demanded symbol body needs its own reserved function and receiver ABI", () => {
  const mod = moduleFor();
  const descriptor = mod.classes![0]!.symbolMethods![0]!;
  descriptor.function = "%Box.%symbol.iterator";
  expect(validateSymbolMethods(mod)).not.toEqual([]);
  const fn = { name: descriptor.function, params: [{ localId: "p0", name: "this", type: { kind: "object", className: "Box" } as IrType }], locals: [], returnType: VOID, body: [], loc };
  mod.functions.push(fn);
  expect(validateSymbolMethods(mod)).toEqual([]);
  fn.params[0]!.type = { kind: "string" };
  expect(validateSymbolMethods(mod)).not.toEqual([]);
  fn.params[0]!.type = { kind: "object", className: "Box" };
  descriptor.function = "main";
  expect(validateSymbolMethods(mod)).not.toEqual([]);
});

test("erasure checks inherited symbol descriptors through composites and cycles", () => {
  const mod = moduleFor();
  mod.classes!.push({ name: "Child", base: "Box", fields: [], loc }, { name: "Other", fields: [], loc });
  mod.records = [{ id: "r", fields: [{ name: "self", type: { kind: "record", shapeId: "r" } }, { name: "child", type: { kind: "object", className: "Child" } }] }];
  expect(containsSymbolMethods({ kind: "record", shapeId: "r" }, mod)).toBe(true);
  expect(containsSymbolMethods({ kind: "array", elem: { kind: "object", className: "Child" } }, mod)).toBe(true);
  expect(containsSymbolMethods({ kind: "object", className: "Other" }, mod)).toBe(false);
  mod.classes![0]!.symbolMethods = [];
  expect(containsSymbolMethods({ kind: "record", shapeId: "r" }, mod)).toBe(false);
});

test("module validation refuses descriptor-losing erasure before backend emission", () => {
  const mod = moduleFor();
  const type: IrType = { kind: "object", className: "Box" };
  mod.functions.push({ name: "erase", params: [{ localId: "p0", name: "value", type }],
    locals: [{ id: "p0", name: "value", type, mutable: false }], returnType: VOID, loc,
    body: [{ kind: "exprStmt", expr: { kind: "dynFrom", value: { kind: "varRef", localId: "p0", type, loc }, type: { kind: "dyn" }, loc }, loc }] });
  expect(validateModule(mod).some(error => error.message.includes("erasing symbol methods"))).toBe(true);
  mod.classes![0]!.symbolMethods = [];
  expect(validateModule(mod)).toEqual([]);
});

test("direct WeakMap keys retain opaque class identity without permitting value erasure", () => {
  const mod = moduleFor();
  mod.classes!.push({ name: "native_builtin_WeakMap", fields: [], loc });
  const params = [
    { localId: "p0", name: "owner", type: { kind: "object", className: "native_builtin_WeakMap" } as IrType },
    { localId: "p1", name: "key", type: { kind: "object", className: "Box" } as IrType },
  ];
  const read = (index: number): IrExpr => ({ kind: "varRef", localId: params[index]!.localId, type: params[index]!.type, loc });
  const key: IrExpr = { kind: "dynFrom", value: read(1), type: DYN, loc };
  const call: Extract<IrExpr, { kind: "libCall" }> = { kind: "libCall", fn: "weakmap.has", args: [read(0), key], type: BOOL, loc };
  mod.functions.push({ name: "opaque", params,
    locals: params.map(param => ({ id: param.localId, name: param.name, type: param.type, mutable: false })),
    returnType: VOID, loc, body: [{ kind: "exprStmt", expr: call, loc }] });
  expect(validateModule(mod)).toEqual([]);
  call.fn = "weakmap.set";
  call.type = VOID;
  call.args.push(key);
  expect(validateModule(mod).some(error => error.message.includes("erasing symbol methods"))).toBe(true);
});
