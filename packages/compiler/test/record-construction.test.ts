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
import { arrayOf, F64, STRING, VOID, type IrExpr, type IrModule, type IrStmt, type IrType } from "../src/ir/ir.js";
import { validateModule } from "../src/ir/validate.js";
import { deserializeModule, serializeModule } from "../src/ir/serialize.js";

const execute = promisify(execFile);
const loc = { file: "record-construction.ts", start: 0, end: 0 };
const record: IrType = { kind: "record", shapeId: "r0" };
function construct(keys: string[]): IrExpr {
  return { kind: "libCall", fn: "record.cloneOwn", args: [
    { kind: "recordLit", fields: [{ name: "a", value: { kind: "numLit", value: 7, type: F64, loc } }], type: record, loc },
    { kind: "arrayLit", elems: keys.map(value => ({ kind: "strLit", value, type: STRING, loc })), type: arrayOf(STRING), loc },
  ], type: record, loc };
}
function fixture(): IrModule {
  return { irVersion: 13, sourceFile: loc.file, entry: "main", records: [{ id: "r0", fields: [{ name: "a", type: F64 }] }], functions: [{
    name: "main", params: [], returnType: VOID, locals: [], body: [{ kind: "exprStmt", expr: construct(["a"]), loc }], loc,
  }] };
}
test("own-key construction validates and serializes its structural signature", () => {
  const module = fixture();
  expect(validateModule(module)).toEqual([]);
  expect(deserializeModule(serializeModule(module))).toEqual(module);
  const expression = (module.functions[0]!.body[0] as Extract<IrStmt, { kind: "exprStmt" }>).expr as Extract<IrExpr, { kind: "libCall" }>;
  expression.args.pop();
  expect(validateModule(module).some(error => error.message.includes("record.cloneOwn"))).toBe(true);
});
test.each([["C", emitCModule], ["LLVM", emitLlvmModule]] as const)("%s explicitly refuses the unported construction operation", (_, emit) => {
  expect(() => emit(fixture())).toThrow(/record.cloneOwn/);
});
test("Rust checks duplicate, unknown and missing required keys without bypassing catches", async () => {
  const module = fixture();
  const log = (value: IrExpr): IrStmt => ({ kind: "exprStmt", expr: { kind: "intrinsic", name: "console.log", args: [value], type: VOID, loc }, loc });
  module.functions[0]!.body = [log({ kind: "recordGet", obj: construct(["a"]), shapeId: "r0", field: "a", type: F64, loc })];
  for (const keys of [["a", "a"], ["unknown"], []]) module.functions[0]!.body.push({
    kind: "tryCatch", tryBody: [{ kind: "exprStmt", expr: construct(keys), loc }], catchLocalId: null,
    catchBody: [log({ kind: "strLit", value: "refused", type: STRING, loc })], finallyBody: null, loc,
  });
  expect(validateModule(module)).toEqual([]);
  const directory = await mkdtemp(join(tmpdir(), "scriptc-record-construction-"));
  try {
    const sourcePath = join(directory, "program.rs");
    const outPath = join(directory, process.platform === "win32" ? "program.exe" : "program");
    await writeFile(sourcePath, emitRustModule(module));
    await compileRust({ sourcePath, outPath, optimization: "dev", runtimeFeatures: [], allowEngine: false });
    const actual = await execute(outPath, [], { env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" } });
    expect(actual).toEqual({ stdout: "7\nrefused\nrefused\nrefused\n", stderr: "" });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 120_000);
