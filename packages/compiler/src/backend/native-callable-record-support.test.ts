import { expect, test } from "vitest";
import { DYN, F64, STRING, VOID, funcOf, type IrModule, type IrType } from "../ir/ir.js";
import { validateModule } from "../ir/validate.js";
import { nativeCallableRecordBackendDiagnostics } from "./native-callable-record-support.js";
import { nativeModuleBackendDiagnostics } from "./native-module-support.js";

const loc = { file: "callable-boundary.ts", start: 0, end: 1 };
const record: IrType = { kind: "record", shapeId: "api" };

function boundary(type: IrType, boxed = false): IrModule {
  const valueType = boxed ? type : DYN;
  const value = { kind: "varRef", localId: "%g.value", type: valueType, loc } as const;
  return {
    irVersion: 8, sourceFile: loc.file, entry: "main",
    records: [
      { id: "api", fields: [{ name: "read", type: funcOf([], F64) }] },
      { id: "wrapper", fields: [{ name: "consume", type: funcOf([record], VOID) }] },
    ],
    globals: [{ id: "%g.value", name: "value", type: valueType, mutable: true }],
    functions: [{ name: "main", params: [], locals: [], returnType: VOID, loc,
      body: [{ kind: "exprStmt", loc, expr: boxed
        ? { kind: "dynFrom", type: DYN, loc, value }
        : { kind: "dynCheck", type, loc, value },
      }],
    }],
  };
}

// A checked callable boxes its typed arguments and checks its dynamic result.
// Passing a callback reverses the conversion direction again.
test.each([
  { name: "outbound callable-record argument", type: funcOf([record], VOID), refused: false },
  { name: "inbound callable-record result", type: funcOf([], record), refused: true },
  { name: "callback returning an outbound record", type: funcOf([funcOf([], record)], VOID), refused: false },
  { name: "callback checking an inbound record", type: funcOf([funcOf([record], VOID)], VOID), refused: true },
  { name: "returned function boxing a record argument", type: funcOf([], funcOf([record], VOID)), refused: false },
  { name: "returned function checking a record result", type: funcOf([], funcOf([], record)), refused: true },
  { name: "direct shared record exit", type: record, refused: true },
])("C/LLVM admission follows conversion direction: $name", ({ type, refused }) => {
  const module = boundary(type);
  expect(validateModule(module)).toEqual([]);
  for (const backend of ["c", "llvm"] as const) {
    const diagnostics = nativeCallableRecordBackendDiagnostics(module, backend);
    if (refused) expect(diagnostics).toEqual([expect.objectContaining({ code: "SC3001", loc })]);
    else expect(diagnostics).toEqual([]);
  }
});

test.each([
  { name: "typed function checking record arguments", type: funcOf([record], VOID), refused: true },
  { name: "typed function boxing record results", type: funcOf([], record), refused: false },
  { name: "boxed method checking record arguments", type: { kind: "record", shapeId: "wrapper" } as IrType, refused: true },
  { name: "boxed callback checking record results", type: funcOf([funcOf([], record)], VOID), refused: true },
  { name: "boxed callback boxing record arguments", type: funcOf([funcOf([record], VOID)], VOID), refused: false },
])("C/LLVM boxed callable admission: $name", ({ type, refused }) => {
  const module = boundary(type, true);
  expect(validateModule(module)).toEqual([]);
  for (const backend of ["c", "llvm"] as const) {
    expect(nativeCallableRecordBackendDiagnostics(module, backend)).toHaveLength(refused ? 1 : 0);
  }
});

test.each([
  { name: "heterogeneous shared record", heterogeneous: true, boxed: true, refused: true },
  { name: "homogeneous outbound snapshot", heterogeneous: false, boxed: true, refused: false },
  { name: "existing dynamic receiver", heterogeneous: true, boxed: false, refused: false },
])("bare dynamic keyed-read admission: $name", ({ heterogeneous, boxed, refused }) => {
  const read = funcOf([], F64);
  const valueType = boxed ? record : DYN;
  const value = { kind: "varRef", localId: "%g.value", type: valueType, loc } as const;
  const module: IrModule = {
    irVersion: 8, sourceFile: loc.file, entry: "main",
    records: [{ id: "api", fields: [{ name: "read", type: read }, { name: "version", type: heterogeneous ? F64 : read }] }],
    globals: [{ id: "%g.value", name: "value", type: valueType, mutable: true }],
    functions: [{ name: "main", params: [], locals: [], returnType: VOID, loc,
      body: [{ kind: "exprStmt", loc, expr: { kind: "dynKeyGet", type: DYN, loc,
        value: boxed ? { kind: "dynFrom", value, type: DYN, loc } : value,
        key: { kind: "strLit", value: "read", type: STRING, loc },
      } }],
    }],
  };
  expect(validateModule(module)).toEqual([]);
  for (const backend of ["c", "llvm"] as const) {
    expect(nativeModuleBackendDiagnostics(module, backend)).toEqual(refused ? [{
      code: "SC3001", loc,
      message: `the ${backend} backend does not support shared heterogeneous record keyed reads yet; use --backend rust`,
    }] : []);
  }
  expect(nativeModuleBackendDiagnostics(module, "rust")).toEqual([]);
});

test.each([
  { name: "direct byte record check", type: record, boxed: false, refused: true },
  { name: "nested byte record check", type: { kind: "record", shapeId: "wrapper" } as IrType, boxed: false, refused: true },
  { name: "optional byte record check", type: { kind: "record", shapeId: "optional" } as IrType, boxed: false, refused: true },
  { name: "outbound byte record snapshot", type: record, boxed: true, refused: false },
  { name: "existing direct byte check", type: { kind: "bytes", elem: "u8" } as IrType, boxed: false, refused: false },
  { name: "boxed callable checking byte record arguments", type: funcOf([record], VOID), boxed: true, refused: true },
])("byte record admission follows conversion direction: $name", ({ type, boxed, refused }) => {
  const module = boundary(type, boxed);
  module.records = [
    { id: "api", fields: [{ name: "data", type: { kind: "bytes", elem: "u8" } }] },
    { id: "wrapper", fields: [{ name: "part", type: record }] },
    { id: "optional", fields: [{ name: "data", type: { kind: "union", unionId: "optionalBytes" } }] },
  ];
  module.unions = [{ id: "optionalBytes", arms: [{ kind: "bytes", elem: "u8" }, { kind: "undefinedT" }] }];
  expect(validateModule(module)).toEqual([]);
  for (const backend of ["c", "llvm"] as const) {
    expect(nativeModuleBackendDiagnostics(module, backend)).toEqual(refused ? [{
      code: "SC3001", loc,
      message: `the ${backend} backend does not support shared record exits with byte fields yet; use --backend rust`,
    }] : []);
  }
  expect(nativeModuleBackendDiagnostics(module, "rust")).toEqual([]);
});
