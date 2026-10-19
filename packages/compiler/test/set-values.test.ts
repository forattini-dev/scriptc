import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { emitRustModule } from "../src/backend/rust/emitter.js";
import { compileRust } from "../src/backend/rust/compile.js";
import { BOOL, DYN, F64, VOID, type IrExpr, type IrModule, type IrStmt, type IrType } from "../src/ir/ir.js";
import { validateModule } from "../src/ir/validate.js";

const execute = promisify(execFile);
const loc = { file: "set-values.ts", start: 0, end: 0 };
const set: IrType = { kind: "set", elem: DYN };
const array: IrType = { kind: "array", elem: DYN };
const number = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const boxed = (value: number): IrExpr => ({ kind: "dynFrom", value: number(value), type: DYN, loc });
const receiver = (): IrExpr => ({ kind: "varRef", localId: "set", type: set, loc });
const operation = (method: "add" | "has" | "delete" | "size" | "toArray", args: IrExpr[], type: IrType): IrExpr => ({ kind: "setIntrinsic", method, args, receiver: receiver(), type, loc });
const log = (expr: IrExpr): IrStmt => ({ kind: "exprStmt", expr: { kind: "intrinsic", name: "console.log", args: [expr], type: VOID, loc }, loc });
const item = (index: number): IrExpr => ({ kind: "arrayGet", arr: operation("toArray", [], array), index: number(index), type: DYN, loc });
const reciprocal = (index: number): IrExpr => ({ kind: "bin", op: "/", left: number(1), right: { kind: "dynCheck", value: item(index), type: F64, loc }, type: F64, loc });

function fixture(seeded: boolean): IrModule {
  const seed: IrExpr = { kind: "dynCheck", value: { kind: "dynArrLit", elems: [NaN, NaN, -0, 0].map(boxed), type: DYN, loc }, type: array, loc };
  const body: IrStmt[] = [{ kind: "varDecl", localId: "set", init: { kind: "setNew", ...(seeded ? { seed } : {}), type: set, loc }, loc }];
  if (!seeded) for (const value of [NaN, NaN, -0, 0]) body.push({ kind: "exprStmt", expr: operation("add", [boxed(value)], VOID), loc });
  body.push(log(operation("size", [], F64)), log(operation("has", [boxed(NaN)], BOOL)), log(reciprocal(1)), log(operation("delete", [boxed(NaN)], BOOL)), { kind: "exprStmt", expr: operation("add", [boxed(NaN)], VOID), loc }, log(reciprocal(0)), log({ kind: "dynTest", test: "nan", value: item(1), type: BOOL, loc }));
  return { irVersion: 13, sourceFile: loc.file, entry: "main", functions: [{ name: "main", params: [], returnType: VOID, locals: [{ id: "set", name: "set", type: set, mutable: false }], body, loc }] };
}

test.each([true, false])("reference Rust Set preserves SameValueZero, normalized zero and insertion order (seeded=%s)", async seeded => {
  const module = fixture(seeded);
  expect(validateModule(module)).toEqual([]);
  const oracle = process.env["SCRIPTC_NODE_ORACLE"] ?? process.execPath;
  expect((await execute(oracle, ["--version"])).stdout.trim()).toBe("v24.15.0");
  const source = `const s = new Set(${seeded ? "[NaN,NaN,-0,0]" : ""}); ${seeded ? "" : "for(const v of [NaN,NaN,-0,0]) s.add(v);"} console.log(s.size); console.log(s.has(NaN)); console.log(1/[...s][1]); console.log(s.delete(NaN)); s.add(NaN); console.log(1/[...s][0]); console.log(Number.isNaN([...s][1]));`;
  const expected = await execute(oracle, ["--input-type=module", "--eval", source]);
  const directory = await mkdtemp(join(tmpdir(), "scriptc-set-values-"));
  try {
    const sourcePath = join(directory, "program.rs");
    const outPath = join(directory, process.platform === "win32" ? "program.exe" : "program");
    await writeFile(sourcePath, emitRustModule(module));
    await compileRust({ sourcePath, outPath, optimization: "dev", runtimeFeatures: [], allowEngine: false });
    expect(await execute(outPath, [], { env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" } })).toEqual(expected);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 120_000);
