import { expect, test } from "vitest";
import { F64, VOID, type IrExpr, type IrModule } from "./ir.js";
import { deserializeModuleBytes, serializeModuleParts } from "./serialize.js";
import { validateModule } from "./validate.js";

const loc = { file: "adoption.ts", start: 0, end: 1 };
function moduleWithReturn(): { module: IrModule; adoption: Extract<IrExpr, { kind: "awaitExpr" }> } {
  const promise = { kind: "promise" as const, inner: F64 };
  const adoption: Extract<IrExpr, { kind: "awaitExpr" }> = {
    kind: "awaitExpr", adopt: true,
    value: { kind: "varRef", localId: "promise", type: promise, loc }, type: F64, loc,
  };
  const module: IrModule = {
    irVersion: 13, sourceFile: loc.file, entry: "main",
    functions: [{ name: "main", async: true, params: [{ name: "promise", localId: "promise", type: promise }],
      locals: [{ name: "promise", id: "promise", type: promise, mutable: false }],
      returnType: F64, body: [{ kind: "return", value: adoption, loc }], loc }],
  };
  return { module, adoption };
}

test("async return adoption survives streamed IR and allows a discarded settled value", () => {
  const { module, adoption } = moduleWithReturn();
  expect(validateModule(module)).toEqual([]);
  expect(deserializeModuleBytes(Buffer.from(serializeModuleParts(module).join("")))).toEqual(module);
  module.functions[0]!.returnType = VOID;
  adoption.type = VOID;
  expect(validateModule(module)).toEqual([]);
});

test("adoption cannot appear in synchronous bodies or erase an incorrect payload type", () => {
  const { module, adoption } = moduleWithReturn();
  delete module.functions[0]!.async;
  expect(validateModule(module).map(error => error.message)).toContain("in main: promise return adoption requires an async non-generator function");
  module.functions[0]!.async = true;
  adoption.type = { kind: "string" };
  expect(validateModule(module).some(error => error.message.includes("await type string != promise inner f64"))).toBe(true);
});

test("adoption cannot be evaluated as an ordinary awaited expression", () => {
  const { module, adoption } = moduleWithReturn();
  module.functions[0]!.returnType = VOID;
  module.functions[0]!.body = [{ kind: "exprStmt", expr: adoption, loc }];
  expect(validateModule(module).some(error => error.message.includes("adoption must be the returned value"))).toBe(true);
});
