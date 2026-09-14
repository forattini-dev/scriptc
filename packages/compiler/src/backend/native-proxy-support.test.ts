import { expect, test } from "vitest";
import { BOOL, DYN, STRING, VOID, type IrExpr, type IrModule, type IrRecordShape, type IrType, type IrUnionDef } from "../ir/ir.js";
import { nativeProxyBackendDiagnostics } from "./native-proxy-support.js";
import { nativeModuleBackendDiagnostics } from "./native-module-support.js";

const loc = { file: "proxy-boundary.ts", start: 10, end: 30 };
const symbol: IrType = { kind: "symbol" };
const backends = ["c", "llvm"] as const;
const ref = (type: IrType): IrExpr => ({ kind: "varRef", localId: "value.0", type, loc });

function moduleWith(expr: IrExpr, records?: IrRecordShape[], unions?: IrUnionDef[]): IrModule {
  return { irVersion: 8, sourceFile: loc.file, entry: "main", ...(records ? { records } : {}), ...(unions ? { unions } : {}),
    functions: [{ name: "main", params: [], locals: [], returnType: VOID,
      body: [{ kind: "exprStmt", expr, loc }], loc }] };
}

function expectRefusal(mod: IrModule): void {
  for (const backend of backends) {
    const expected = [{ code: "SC3001", loc,
      message: `the ${backend} backend does not support native Proxy references or dynamic Symbol transport yet; use --backend rust`,
    }];
    expect(nativeProxyBackendDiagnostics(mod, backend)).toEqual(expected);
    expect(nativeModuleBackendDiagnostics(mod, backend)).toEqual(expected);
  }
  expect(nativeModuleBackendDiagnostics(mod, "rust")).toEqual([]);
}

test("native Proxy construction refuses at its source location", () => {
  expectRefusal(moduleWith({ kind: "libCall", fn: "dyn.proxyNew", args: [ref(DYN), ref(DYN)], type: DYN, loc }));
});

test("dynamic Symbol tests and symbol or opaque property keys refuse", () => {
  expectRefusal(moduleWith({ kind: "dynTest", test: "symbol", value: ref(DYN), type: BOOL, loc }));
  for (const key of [symbol, DYN]) {
    expectRefusal(moduleWith({ kind: "dynKeyGet", value: ref(DYN), key: ref(key), type: DYN, loc }));
  }
});

test("Symbol boxing and extraction refuse through callbacks and composite types", () => {
  const record: IrType = { kind: "record", shapeId: "entry" };
  const union: IrType = { kind: "union", unionId: "optional" };
  const records: IrRecordShape[] = [{ id: "entry", fields: [{ name: "key", type: symbol }] },
    { id: "dictionary", fields: [], indexValue: union }];
  const unions: IrUnionDef[] = [{ id: "optional", arms: [record, { kind: "undefinedT" }] }];
  const types: IrType[] = [symbol, record, union, { kind: "record", shapeId: "dictionary" },
    { kind: "func", params: [symbol], ret: VOID }, { kind: "func", params: [], ret: { kind: "array", elem: union } },
    { kind: "map", key: symbol, value: STRING }, { kind: "set", elem: symbol }, { kind: "promise", inner: symbol },
    { kind: "generator", yieldT: symbol, retT: STRING, nextT: VOID },
  ];
  for (const type of types) {
    expectRefusal(moduleWith({ kind: "dynFrom", value: ref(type), type: DYN, loc }, records, unions));
    expectRefusal(moduleWith({ kind: "dynCheck", value: ref(DYN), type, loc }, records, unions));
  }
});

test("recursive shapes terminate and do not confuse record and union identifiers", () => {
  const type: IrType = { kind: "record", shapeId: "same" };
  const records: IrRecordShape[] = [{ id: "same", fields: [
    { name: "next", type }, { name: "key", type: { kind: "union", unionId: "same" } },
  ] }];
  const union: IrUnionDef = { id: "same", arms: [type, symbol] };
  const expr: IrExpr = { kind: "dynFrom", value: ref(type), type: DYN, loc };
  expectRefusal(moduleWith(expr, records, [union]));
  union.arms = [type, STRING];
  for (const backend of backends) expect(nativeProxyBackendDiagnostics(moduleWith(expr, records, [union]), backend)).toEqual([]);
});

test("ordinary typed Symbols and string dynamic keys retain existing backend support", () => {
  const exprs: IrExpr[] = [ref(symbol),
    { kind: "bin", op: "===", left: ref(symbol), right: ref(symbol), type: BOOL, loc },
    { kind: "dynKeyGet", value: ref(DYN), key: ref(STRING), type: DYN, loc },
    { kind: "dynFrom", value: ref(STRING), type: DYN, loc },
  ];
  for (const expr of exprs) for (const backend of backends) {
    const mod = moduleWith(expr, [{ id: "unused", fields: [{ name: "key", type: symbol }] }]);
    expect(nativeProxyBackendDiagnostics(mod, backend)).toEqual([]);
  }
});
