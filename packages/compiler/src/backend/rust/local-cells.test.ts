import { expect, test } from "vitest";
import type { IrExpr, IrFunction, IrModule } from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { emitRustModule } from "./emitter.js";
import { mangleLocal } from "../mangle.js";

const loc = { file: "local-cells.ts", start: 0, end: 1 };
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: { kind: "f64" }, loc });
function fixture(): { fn: IrFunction; mod: IrModule } {
  const fn: IrFunction = { name: "main", params: [], returnType: { kind: "void" }, loc,
    locals: [{ id: "value", name: "value", type: { kind: "f64" }, mutable: true }],
    body: [
      { kind: "varDecl", localId: "value", init: null, loc },
      { kind: "assign", localId: "value", value: num(7), loc },
      { kind: "exprStmt", expr: { kind: "varRef", localId: "value", type: { kind: "f64" }, loc }, loc },
    ],
  };
  return { fn, mod: { irVersion: 6, sourceFile: loc.file, entry: fn.name, functions: [fn] } };
}

test("uncaptured scalar cells stay on the stack with an initialization check", () => {
  const { mod } = fixture();
  expect(validateModule(mod)).toEqual([]);
  const original = structuredClone(mod);
  const rust = emitRustModule(mod);
  const name = mangleLocal("value");
  expect(rust).toContain(`${name}: std::cell::Cell<Option<f64>> = std::cell::Cell::new(None)`);
  expect(rust).toContain(`${name}.set(Some(7.0_f64))`);
  expect(rust).toContain(`${name}.get().expect("scriptc: read of an uninitialized captured binding")`);
  expect(rust).not.toContain("runtime::cell_empty()");
  expect(mod).toEqual(original);
});

test("captured and TDZ scalar cells retain shared heap storage", () => {
  for (const flag of ["boxed", "tdz"] as const) {
    const { fn, mod } = fixture();
    const local = fn.locals[0];
    if (!local) throw new Error("missing local");
    local[flag] = true;
    expect(emitRustModule(mod)).toContain(`${mangleLocal("value")}: runtime::JsCell<f64> = runtime::cell_empty()`);
  }
});

test("forced-cell decisions reject suspended frames and reset between functions", async () => {
  const { RustLocalCells } = await import("./local-cells.js");
  const { fn } = fixture();
  let current: IrFunction | null = fn;
  const cells = new RustLocalCells(() => current);
  cells.set("value", true);
  expect(cells.isStack("value")).toBe(true);
  cells.clear();
  expect(cells.has("value")).toBe(false);
  fn.async = true;
  cells.set("value", true);
  expect(cells.isStack("value")).toBe(false);
  delete fn.async;
  fn.generator = { yieldT: { kind: "f64" }, nextT: { kind: "undefinedT" } };
  cells.set("value", true);
  expect(cells.isStack("value")).toBe(false);
  cells.set("value", false);
  expect(cells.has("value")).toBe(false);
  current = null;
  cells.set("value", true);
  expect(cells.isStack("value")).toBe(false);
});
