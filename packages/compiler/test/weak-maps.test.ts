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
const loc = { file: "weak-maps.ts", start: 0, end: 0 };
const owner: IrType = { kind: "object", className: "native_builtin_WeakMap" };
const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
const number = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const boxed = (value: IrExpr): IrExpr => ({ kind: "dynFrom", value, type: DYN, loc });
const statement = (expr: IrExpr): IrStmt => ({ kind: "exprStmt", expr, loc });
const log = (expr: IrExpr): IrStmt => statement({ kind: "intrinsic", name: "console.log", args: [expr], type: VOID, loc });
const operation = (fn: "weakmap.set" | "weakmap.get" | "weakmap.has" | "weakmap.delete", args: IrExpr[], type: IrType): IrExpr => ({ kind: "libCall", fn, args: [ref("owner", owner), ...args], type, loc });
function fixture(): IrModule {
  return { irVersion: 13, sourceFile: loc.file, entry: "main", classes: [{ name: "native_builtin_WeakMap", jsName: "WeakMap", fields: [], methods: [], methodNames: [], loc }], functions: [
    { name: "%native_builtin_WeakMap.constructor", params: [{ localId: "this", name: "this", type: owner }], locals: [{ id: "this", name: "this", type: owner, mutable: false }], returnType: VOID, body: [], loc },
    { name: "main", params: [], locals: [{ id: "owner", name: "owner", type: owner, mutable: false }, { id: "key", name: "key", type: DYN, mutable: false }], returnType: VOID, body: [
      { kind: "varDecl", localId: "owner", init: { kind: "new", className: "native_builtin_WeakMap", args: [], type: owner, loc }, loc },
      { kind: "varDecl", localId: "key", init: { kind: "dynObjLit", fields: [], type: DYN, loc }, loc },
      statement(operation("weakmap.set", [ref("key", DYN), boxed(number(17))], VOID)),
      log({ kind: "dynCheck", value: operation("weakmap.get", [ref("key", DYN)], DYN), type: F64, loc }),
      log(operation("weakmap.has", [ref("key", DYN)], BOOL)),
      log(operation("weakmap.delete", [ref("key", DYN)], BOOL)),
      log({ kind: "dynTest", test: "undefined", value: operation("weakmap.get", [ref("key", DYN)], DYN), type: BOOL, loc }),
    ], loc },
  ] };
}

test("weak map nominal receivers and dynamic payload signatures survive serialization and reject malformed operations", () => {
  const module = fixture(); expect(validateModule(module)).toEqual([]);
  expect(deserializeModule(serializeModule(module))).toEqual(module);
  const body = module.functions[1]!.body;
  for (const expr of [operation("weakmap.set", [ref("key", DYN)], VOID), operation("weakmap.get", [number(1)], DYN), operation("weakmap.get", [ref("key", DYN)], STRING)]) {
    body.push(statement(expr)); expect(validateModule(module).some(error => error.message.includes("invalid native weak map operation"))).toBe(true); body.pop();
  }
});

test.each([["C", emitCModule], ["LLVM", emitLlvmModule]] as const)("%s explicitly refuses Rust weak maps", (_, emit) => {
  expect(() => emit(fixture())).toThrow(/weakmap/);
});

test("reference Rust weak map operations execute without an engine and match Node", async () => {
  const module = fixture(); expect(validateModule(module)).toEqual([]);
  const oracle = process.env["SCRIPTC_NODE_ORACLE"] ?? process.execPath;
  expect((await execute(oracle, ["--version"])).stdout.trim()).toBe("v24.15.0");
  const expected = await execute(oracle, ["--input-type=module", "--eval", "const m=new WeakMap(), k={};m.set(k,17);console.log(m.get(k));console.log(m.has(k));console.log(m.delete(k));console.log(m.get(k)===undefined);"]);
  const directory = await mkdtemp(join(tmpdir(), "scriptc-weak-map-api-"));
  try {
    const sourcePath = join(directory, "program.rs"), outPath = join(directory, process.platform === "win32" ? "program.exe" : "program");
    await writeFile(sourcePath, emitRustModule(module));
    await compileRust({ sourcePath, outPath, optimization: "dev", runtimeFeatures: [], allowEngine: false });
    expect(await execute(outPath, [], { env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" } })).toEqual(expected);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 120_000);
