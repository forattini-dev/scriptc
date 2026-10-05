import { resolve } from "node:path";
import { expect, test } from "vitest";
import * as ts from "../ts7/adapter.js";
import { loadProgram } from "../program.js";
import { validateModule } from "../../ir/validate.js";
import { deferJsAsyncMethod } from "./js-async-methods.js";
import { Lowerer, lowerToIr } from "./lowerer.js";

test("async deferral follows inherited declaration identity, not a shared method name", () => {
  const load = loadProgram(resolve("tests/corpus/3439-js-async-method-deferred-family.mjs"));
  try {
    const lowerer = new Lowerer(load.program, load.entry, load.moduleOrder, false);
    const initialClasses = [...lowerer.classes.keys()];
    const decisions: Record<string, boolean> = {};
    for (const statement of load.entry.statements) {
      if (!ts.isClassDeclaration(statement) || !statement.name) continue;
      for (const member of statement.members) {
        if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === "value") {
          decisions[statement.name.text] = deferJsAsyncMethod(lowerer, member);
        }
      }
    }
    expect(decisions).toEqual({ Base: true, Child: true, Unrelated: false, SyncBase: false, AsyncChild: true });
    expect([...lowerer.classes.keys()]).toEqual(initialClasses);
  } finally { load.dispose(); }
});

test("unreached virtual async bodies do not lower while a closed family does", () => {
  const load = loadProgram(resolve("tests/corpus/3439-js-async-method-deferred-family.mjs"));
  try {
    const result = lowerToIr(load.program, load.entry, load.moduleOrder);
    expect(result.diagnostics).toEqual([]);
    expect(result.runtimeFences).toEqual([]);
    if (!result.module) throw new Error("expected a lowered module");
    expect(validateModule(result.module)).toEqual([]);
    expect(result.module.functions.some(fn => /(?:^|[%.])Base\.value$/.test(fn.name))).toBe(false);
    expect(result.module.functions.some(fn => /(?:^|[%.])Child\.value$/.test(fn.name))).toBe(false);
    expect(result.module.functions.some(fn => fn.name.endsWith("Unrelated.value") && fn.async)).toBe(true);
  } finally { load.dispose(); }
});
