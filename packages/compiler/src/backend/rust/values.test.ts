import { expect, test } from "vitest";
import { VOID, funcOf, type IrModule } from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { emitRustModule } from "./emitter.js";

test.each([false, true])("global function initialization checks respect lexical storage: mutable=%s", mutable => {
  const loc = { file: "global-function.mjs", start: 0, end: 1 };
  const type = funcOf([], VOID);
  const global = { id: "%g.factory", name: "factory", type, mutable };
  const module: IrModule = {
    irVersion: 12, sourceFile: loc.file, entry: "main", globals: [global],
    functions: [
      { name: "implementation", params: [], locals: [], returnType: VOID, body: [], loc },
      { name: "main", params: [], locals: [], returnType: VOID, loc, body: [
        { kind: "exprStmt", expr: { kind: "varRef", localId: global.id, type, loc }, loc },
        { kind: "assign", localId: global.id, value: { kind: "closure", fnName: "implementation", captures: [], type, loc }, loc },
      ] },
    ],
  };
  expect(validateModule(module)).toEqual([]);
  const original = structuredClone(module);
  const rust = emitRustModule(module);
  if (mutable) expect(rust).toContain('expect("scriptc: uninitialized global")');
  else expect(rust).toContain('runtime::throw_reference_error("Cannot access \'factory\' before initialization".to_owned())');
  expect(module).toEqual(original);
});
