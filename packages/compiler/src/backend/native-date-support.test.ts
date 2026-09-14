import { expect, test } from "vitest";
import { VOID, type IrExpr, type IrModule, type IrType } from "../ir/ir.js";
import { emitCModule } from "./c/c-emitter.js";
import { emitLlvmModule } from "./llvm/emitter.js";
import { nativeModuleBackendDiagnostics } from "./native-module-support.js";

const loc = { file: "date.ts", start: 0, end: 0 };
const date: IrType = { kind: "date" };
const value: IrExpr = { kind: "libCall", fn: "date.newMs", args: [
  { kind: "numLit", value: 0, type: { kind: "f64" }, loc },
], type: date, loc };

function moduleWith(expr?: IrExpr): IrModule {
  return { irVersion: 8, sourceFile: loc.file, entry: "main", globals: [],
    functions: [{ name: "main", params: [], locals: [], returnType: VOID,
      body: expr ? [{ kind: "exprStmt", expr, loc }] : [], loc }] };
}

test("ordinary scalar Date construction remains available to C and LLVM", () => {
  const mod = moduleWith(value);
  for (const backend of ["c", "llvm", "rust"] as const) {
    expect(nativeModuleBackendDiagnostics(mod, backend)).toEqual([]);
  }
  expect(() => emitCModule(mod)).not.toThrow();
  expect(() => emitLlvmModule(mod)).not.toThrow();
});

test("C and LLVM refuse Date identity, boxing, extraction and kind tests", () => {
  const boxed: IrExpr = { kind: "dynFrom", value, type: { kind: "dyn" }, loc };
  const expressions: IrExpr[] = [boxed,
    { kind: "dynCheck", value: boxed, type: date, loc },
    { kind: "bin", op: "===", left: value, right: value, type: { kind: "bool" }, loc },
    { kind: "dynTest", test: "date", value: boxed, type: { kind: "bool" }, loc },
  ];
  for (const expr of expressions) {
    const mod = moduleWith(expr);
    expect(nativeModuleBackendDiagnostics(mod, "rust")).toEqual([]);
    for (const backend of ["c", "llvm"] as const) {
      expect(nativeModuleBackendDiagnostics(mod, backend)).toEqual([{
        code: "SC3001", loc,
        message: `the ${backend} backend does not support native Date object identity and dynamic tags yet; use --backend rust`,
      }]);
    }
    expect(() => emitCModule(mod)).toThrow("native Date object identity");
    expect(() => emitLlvmModule(mod)).toThrow("native Date object identity");
  }
});

test("Date arrays and tagged unions refuse before either legacy emitter runs", () => {
  for (const type of [{ kind: "array", elem: date }, { kind: "union", unionId: "u0" }] satisfies IrType[]) {
    const mod = moduleWith();
    mod.globals = [{ id: "dates", name: "dates", type, mutable: false }];
    if (type.kind === "union") mod.unions = [{ id: "u0", arms: [date, { kind: "f64" }] }];
    expect(nativeModuleBackendDiagnostics(mod, "rust")).toEqual([]);
    expect(() => emitCModule(mod)).toThrow("native Date object identity");
    expect(() => emitLlvmModule(mod)).toThrow("native Date object identity");
  }
});
