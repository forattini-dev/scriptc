import { expect, test } from "vitest";
import { SYMBOL_T, STRING, VOID, type IrExpr, type IrLibFn, type IrModule, type IrType } from "./ir.js";
import { validateModule } from "./validate.js";
import { WELL_KNOWN_SYMBOLS, wellKnownSymbolVariant } from "./well-known-symbols.js";

const loc = { file: "symbols.ts", start: 0, end: 0 };
function moduleFor(fn: IrLibFn, args: IrExpr[], result: IrType): IrModule {
  return {
    irVersion: 13, sourceFile: loc.file, entry: "main",
    functions: [{ name: "main", params: [], locals: [], returnType: VOID, loc,
      body: [{ kind: "exprStmt", expr: { kind: "libCall", fn, args, type: result, loc }, loc }],
    }],
  };
}

test("well-known symbols use zero-argument symbol operations in portable IR", () => {
  expect(Object.keys(WELL_KNOWN_SYMBOLS)).toHaveLength(15);
  for (const fn of Object.keys(WELL_KNOWN_SYMBOLS) as (keyof typeof WELL_KNOWN_SYMBOLS)[]) {
    expect(validateModule(moduleFor(fn, [], SYMBOL_T))).toEqual([]);
    expect(validateModule(moduleFor(fn, [], STRING))).not.toEqual([]);
    const arg: IrExpr = { kind: "strLit", value: "ignored", type: STRING, loc };
    expect(validateModule(moduleFor(fn, [arg], SYMBOL_T))).not.toEqual([]);
  }
});

test("unknown operation names cannot select a runtime symbol", () => {
  for (const name of ["sym.unknown", "iterator", "__proto__", "constructor", "toString"]) {
    expect(wellKnownSymbolVariant(name)).toBeUndefined();
    expect(validateModule(moduleFor(name as IrLibFn, [], SYMBOL_T))).not.toEqual([]);
  }
});
