import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import * as ts from "../ts7/adapter.js";
import { loadProgram } from "../program.js";
import { jsFactoryGlobalType } from "./js-factory-global.js";
import { Lowerer } from "./lowerer.js";

test.each([
  ["a zero-argument arrow", "const factory = () => ({ value: 1 });", 0],
  ["a parameterized arrow", "const factory = config => ({ ...config });", 1],
  ["a parenthesized arrow", "const factory = ((config, value) => ({ ...config, value }));", 2],
  ["a function expression", "const factory = function create(config) { return { ...config }; };", 1],
])("reserves the native dyn-returning signature of %s", (_name, source, arity) => {
  withDeclaration(source, "mjs", (lowerer, declaration) => {
    expect(jsFactoryGlobalType(lowerer, declaration)).toEqual(expect.objectContaining({
      kind: "func", ret: { kind: "dyn" },
      params: Array.from({ length: arity }, () => ({ kind: "dyn" })),
    }));
  });
});

test.each([
  ["a mutable binding", "let factory = config => ({ ...config });", "mjs"],
  ["a defaulted parameter", "const factory = (config = {}) => ({ ...config });", "mjs"],
  ["a rest parameter", "const factory = (...configs) => ({ configs });", "mjs"],
  ["a binding-pattern parameter", "const factory = ({ config }) => ({ config });", "mjs"],
  ["an async function", "const factory = async config => ({ ...config });", "mjs"],
  ["a generator", "const factory = function* (config) { yield config; };", "mjs"],
  ["a primitive-returning function", "const factory = config => 'value';", "mjs"],
  ["an annotated TypeScript binding", "const factory: (config: unknown) => unknown = config => config;", "ts"],
  ["a generic TypeScript function", "const factory = <T>(config: T) => ({ config });", "ts"],
])("leaves %s to its existing lowering path", (_name, source, extension) => {
  withDeclaration(source, extension, (lowerer, declaration) => {
    expect(jsFactoryGlobalType(lowerer, declaration)).toBeNull();
  });
});

function withDeclaration(source: string, extension: string, check: (lowerer: Lowerer, declaration: ts.VariableDeclaration) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-js-factory-global-"));
  try {
    const entry = join(directory, `main.${extension}`);
    writeFileSync(entry, source);
    const load = loadProgram(entry);
    try {
      const statement = load.entry.statements[0];
      if (!statement || !ts.isVariableStatement(statement)) throw new Error("expected a variable statement");
      const declaration = statement.declarationList.declarations[0];
      if (!declaration) throw new Error("expected a variable declaration");
      check(new Lowerer(load.program, load.entry, load.moduleOrder, false), declaration);
    } finally { load.dispose(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
