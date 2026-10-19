import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { emitRustModule } from "../src/backend/rust/emitter.js";
import { compileRust } from "../src/backend/rust/compile.js";
import { F64, STRING, VOID, type IrExpr, type IrModule, type IrStmt } from "../src/ir/ir.js";
import { validateModule } from "../src/ir/validate.js";

const execute = promisify(execFile);
test.each([false, true])("marked lexical globals preserve read/write TDZ and RHS effects against Node; suspended=%s", async suspended => {
  const loc = { file: "globals.mjs", start: 0, end: 1 };
  const number = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
  const text = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
  const log = (expr: IrExpr): IrStmt => ({ kind: "exprStmt", expr: { kind: "intrinsic", name: "console.log", args: [expr], type: VOID, loc }, loc });
  const ref: IrExpr = { kind: "varRef", localId: "%g.x", type: F64, loc };
  const guarded = (statement: IrStmt, message: string): IrStmt => ({ kind: "tryCatch", tryBody: [statement], catchLocalId: null, catchBody: [log(text(message))], finallyBody: null, loc });
  const module: IrModule = {
    irVersion: 13, sourceFile: loc.file, entry: "main", globals: [{ id: "%g.x", name: "x", type: F64, mutable: true }],
    functions: [
      { name: "rhs", params: [], locals: [], returnType: F64, loc, body: [log(text("rhs")), { kind: "return", value: number(3), loc }] },
      { name: "main", params: [], locals: [], returnType: VOID, loc, ...(suspended ? { async: true as const } : {}), body: [
        guarded(log(ref), "read refused"),
        guarded({ kind: "assign", localId: "%g.x", value: { kind: "call", callee: "rhs", args: [], type: F64, loc }, loc }, "write refused"),
        { kind: "assign", localId: "%g.x", value: suspended ? { kind: "awaitExpr", value: { kind: "intrinsic", name: "promise.resolve", args: [number(5)], type: { kind: "promise", inner: F64 }, loc }, type: F64, loc } : number(5), initializesGlobal: true, loc }, log(ref),
        { kind: "assign", localId: "%g.x", value: number(7), loc }, log(ref),
      ] },
    ],
  };
  expect(validateModule(module)).toEqual([]);
  const original = structuredClone(module);
  const directory = await mkdtemp(join(tmpdir(), "scriptc-global-initialization-"));
  try {
    const sourcePath = join(directory, "main.rs");
    const outPath = join(directory, process.platform === "win32" ? "main.exe" : "main");
    await writeFile(sourcePath, emitRustModule(module));
    await compileRust({ sourcePath, outPath, optimization: "dev", runtimeFeatures: [], allowEngine: false });
    const source = "try { console.log(x); } catch { console.log('read refused'); } try { x = rhs(); } catch { console.log('write refused'); } let x = 5; console.log(x); x = 7; console.log(x); function rhs() { console.log('rhs'); return 3; }";
    const oracle = await execute(process.env["SCRIPTC_NODE_ORACLE"] ?? process.execPath, ["-e", suspended ? `(async () => { ${source.replace("let x = 5", "let x = await 5")} })();` : source]);
    const actual = await execute(outPath, [], { env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" } });
    expect(actual).toEqual(oracle);
    expect(actual.stdout).toBe("read refused\nrhs\nwrite refused\n5\n7\n");
    expect(module).toEqual(original);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 120_000);
