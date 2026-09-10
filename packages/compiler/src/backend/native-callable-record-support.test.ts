import { expect, test } from "vitest";
import { DYN, F64, VOID, funcOf, type IrModule, type IrType } from "../ir/nodes.js";
import { validateModule } from "../ir/validate.js";
import { nativeCallableRecordBackendDiagnostics } from "./native-callable-record-support.js";

const loc = { file: "callable-boundary.ts", start: 0, end: 1 };
const record: IrType = { kind: "record", shapeId: "api" };

function boundary(type: IrType, boxed = false): IrModule {
  const valueType = boxed ? type : DYN;
  const value = { kind: "varRef", localId: "%g.value", type: valueType, loc } as const;
  return {
    irVersion: 6, sourceFile: loc.file, entry: "main",
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
