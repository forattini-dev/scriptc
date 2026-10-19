import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { emitCModule } from "../src/backend/c/c-emitter.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import { emitRustModule } from "../src/backend/rust/emitter.js";
import { compileRust } from "../src/backend/rust/compile.js";
import { BOOL, DYN, F64, STRING, VOID, type IrExpr, type IrModule, type IrStmt, type IrType } from "../src/ir/ir.js";
import { validateModule } from "../src/ir/validate.js";
import { deserializeModule, serializeModule } from "../src/ir/serialize.js";

const execute = promisify(execFile);
const loc = { file: "record-views.ts", start: 0, end: 0 };
const narrow: IrType = { kind: "record", shapeId: "base" };
const wide: IrType = { kind: "record", shapeId: "wide" };
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const text = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
function fixture(): IrModule {
  const source: IrExpr = { kind: "recordLit", fields: [{ name: "a", value: num(7) }, { name: "extra", value: text("keep") }], type: wide, loc };
  return { irVersion: 13, sourceFile: loc.file, entry: "main", records: [
    { id: "base", fields: [{ name: "a", type: F64 }] },
    { id: "wide", fields: [{ name: "a", type: F64 }, { name: "extra", type: STRING }] },
  ], functions: [{ name: "main", params: [], returnType: VOID, locals: [], body: [{ kind: "exprStmt", expr: { kind: "libCall", fn: "record.view", args: [source], type: narrow, loc }, loc }], loc }] };
}
test("invariant views validate and serialize without erasing their source type", () => {
  const module = fixture();
  expect(validateModule(module)).toEqual([]);
  expect(deserializeModule(serializeModule(module))).toEqual(module);
  module.records![0]!.fields[0]!.type = STRING;
  expect(validateModule(module).some(e => e.message.includes("record.view"))).toBe(true);
});
test("ambiguous native view tags and malformed own-value plans are refused", () => {
  const module = fixture();
  module.unions = [{ id: "u", arms: [narrow, wide] }];
  const call = (module.functions[0]!.body[0] as Extract<IrStmt, { kind: "exprStmt" }>).expr as Extract<IrExpr, { kind: "libCall" }>;
  call.type = { kind: "union", unionId: "u" };
  expect(validateModule(module).some(e => e.message.includes("record.view"))).toBe(true);
  call.fn = "record.fromOwn"; call.type = narrow;
  expect(validateModule(module).some(e => e.message.includes("record.fromOwn"))).toBe(true);
});
test.each([["C", emitCModule], ["LLVM", emitLlvmModule]] as const)("%s refuses native record views explicitly", (_, emit) => {
  expect(() => emit(fixture())).toThrow(/record.view/);
});
test("own-value construction preserves extras and catches invalid field types, missing keys and non-object plans", async () => {
  const module = fixture();
  const own = (fields: [string, IrExpr][]): IrExpr => ({ kind: "dynObjLit", fields: fields.map(([key, value]) => ({ key: text(key), value: { kind: "dynFrom", value, type: DYN, loc } })), type: DYN, loc });
  const construct = (value: IrExpr): IrExpr => ({ kind: "libCall", fn: "record.fromOwn", args: [{ kind: "recordLit", fields: [{ name: "a", value: num(0) }], type: narrow, loc }, value], type: narrow, loc });
  const log = (value: IrExpr): IrStmt => ({ kind: "exprStmt", expr: { kind: "intrinsic", name: "console.log", args: [value], type: VOID, loc }, loc });
  const valid = construct(own([["a", num(7)], ["extra", text("keep")], ["__proto__", text("own")]]));
  module.functions[0]!.body = [log({ kind: "libCall", fn: "dyn.hasOwn", args: [{ kind: "dynFrom", value: valid, type: DYN, loc }, text("__proto__")], type: BOOL, loc })];
  for (const value of [own([]), own([["a", text("wrong")]]), { kind: "dynFrom", value: text("wrong"), type: DYN, loc } as IrExpr]) module.functions[0]!.body.push({ kind: "tryCatch", tryBody: [{ kind: "exprStmt", expr: construct(value), loc }], catchLocalId: null, catchBody: [log(text("refused"))], finallyBody: null, loc });
  expect(validateModule(module)).toEqual([]);
  const directory = await mkdtemp(join(tmpdir(), "scriptc-record-views-"));
  try {
    const sourcePath = join(directory, "program.rs");
    const outPath = join(directory, process.platform === "win32" ? "program.exe" : "program");
    await writeFile(sourcePath, emitRustModule(module));
    await compileRust({ sourcePath, outPath, optimization: "dev", runtimeFeatures: [], allowEngine: false });
    expect(await execute(outPath, [], { env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" } })).toEqual({ stdout: "true\nrefused\nrefused\nrefused\n", stderr: "" });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 120_000);
