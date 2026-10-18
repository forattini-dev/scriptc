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
import { arrayOf, DYN, F64, funcOf, VOID, type IrExpr, type IrModule, type IrType } from "../src/ir/ir.js";
import { validateModule } from "../src/ir/validate.js";

const execute = promisify(execFile);
const loc = { file: "array-rest-adapter.ts", start: 0, end: 0 };
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });

function fixture(): IrModule {
  const rest: IrType = { kind: "func", params: [arrayOf(F64)], ret: F64, rest: true, restAbi: "array" };
  const callee: IrExpr = { kind: "dynCheck", value: { kind: "dynFrom", value: {
    kind: "closure", fnName: "sum", captures: [], type: funcOf([F64, F64], F64), loc,
  }, type: DYN, loc }, type: rest, loc };
  return {
    irVersion: 13, sourceFile: loc.file, entry: "main",
    functions: [{
      name: "sum", params: ["a", "b"].map(name => ({ localId: name, name, type: F64 })),
      returnType: F64, locals: ["a", "b"].map(name => ({ id: name, name, type: F64, mutable: false })),
      body: [{ kind: "return", value: { kind: "bin", op: "+",
        left: { kind: "varRef", localId: "a", type: F64, loc },
        right: { kind: "varRef", localId: "b", type: F64, loc }, type: F64, loc }, loc }], loc,
    }, {
      name: "main", params: [], returnType: VOID, locals: [],
      body: [{ kind: "exprStmt", expr: { kind: "intrinsic", name: "console.log", args: [{
        kind: "callValue", callee, args: [{ kind: "arrayLit", elems: [num(7), num(8)], type: arrayOf(F64), loc }], type: F64, loc,
      }], type: VOID, loc }, loc }], loc,
    }],
  };
}

test("Rust dynamic adapters flatten a typed rest array before calling another boxed signature", async () => {
  const module = fixture();
  expect(validateModule(module)).toEqual([]);
  const directory = await mkdtemp(join(tmpdir(), "scriptc-rest-adapter-"));
  try {
    const sourcePath = join(directory, "program.rs");
    const outPath = join(directory, process.platform === "win32" ? "program.exe" : "program");
    await writeFile(sourcePath, emitRustModule(module));
    await compileRust({ sourcePath, outPath, optimization: "dev", runtimeFeatures: [], allowEngine: false });
    const expected = await execute(process.env["SCRIPTC_NODE_ORACLE"] ?? process.execPath,
      ["-e", "const sum = (a, b) => a + b; const call = (...items) => sum(...items); console.log(call(7, 8));"]);
    const actual = await execute(outPath, [], { env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" } });
    expect(actual).toEqual(expected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test.each([["C", emitCModule], ["LLVM", emitLlvmModule]] as const)("%s refuses unported typed rest dynamic adapters", (_, emit) => {
  expect(() => emit(fixture())).toThrow(/dynFunc:typed-array-rest/);
});
