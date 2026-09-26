import { expect, test } from "vitest";
import { F64, VOID, type IrExpr, type IrModule, type IrStmt } from "../../ir/ir.js";
import { emitLlvmModule } from "./emitter.js";

const loc = { file: "bitwise-emission.ts", start: 0, end: 0 };

function fixture(): IrModule {
  const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
  const body: IrStmt[] = (["&", "|", "^", "<<", ">>", ">>>"] as const).map((op) => ({
    kind: "exprStmt",
    expr: { kind: "bin", op, left: num(5), right: num(3), type: F64, loc },
    loc,
  }));
  body.push({
    kind: "exprStmt",
    expr: { kind: "unary", op: "~", operand: num(5), type: F64, loc },
    loc,
  });
  return {
    irVersion: 11,
    sourceFile: loc.file,
    entry: "__main",
    functions: [{ name: "__main", params: [], returnType: VOID, locals: [], body, loc }],
  };
}

test("LLVM emits bitwise number operators as native i32 instructions", () => {
  const llvm = emitLlvmModule(fixture());
  expect(llvm).not.toContain(["@", "scr", "_bit_"].join(""));
  expect(llvm).toMatch(/ = and i32 .*?, .*?$/m);
  expect(llvm).toMatch(/ = or i32 .*?, .*?$/m);
  expect(llvm).toMatch(/ = xor i32 .*?, .*?$/m);
  expect(llvm).toMatch(/ = shl i32 .*?, .*?$/m);
  expect(llvm).toMatch(/ = ashr i32 .*?, .*?$/m);
  expect(llvm).toMatch(/ = lshr i32 .*?, .*?$/m);
  expect(llvm).toMatch(/ = and i32 .*?, 31$/m);
  expect(llvm).toMatch(/ = xor i32 .*?, -1$/m);
  expect(llvm).toMatch(/ = uitofp i32 .*? to double$/m);
  expect(llvm).toMatch(/ = sitofp i32 .*? to double$/m);
});
