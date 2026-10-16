import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import * as ts from "./adapter.js";
import { classExtendsElement, heritageTypeName } from "./heritage.js";

test("runtime class bases stay separate from qualified and generic type heritage", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-ts7-heritage-"));
  const entry = join(dir, "entry.ts");
  writeFileSync(entry, `
    namespace Shapes {
      export interface Ready<T> { value: T }
      export class Base { value = 42; }
    }
    interface Child extends Shapes.Ready<number> {}
    class OnlyImplements implements Shapes.Ready<number> { value = 1; }
    class Derived extends Shapes.Base implements Child {}
    type Qualified = Shapes.Ready<number>;
    type Simple = Child;
    const Selected = class extends Shapes.Base {};
    function select() { return Shapes.Base; }
    class Computed extends select() {}
  `);
  const program = ts.createProgram([entry], { noLib: true });
  try {
    expect(program.getSemanticDiagnostics()).toEqual([]);
    const file = program.getSourceFile(entry)!;
    const classes = file.statements.filter(ts.isClassDeclaration);
    const only = classes.find((decl) => decl.name?.text === "OnlyImplements")!;
    const derived = classes.find((decl) => decl.name?.text === "Derived")!;
    const computed = classes.find((decl) => decl.name?.text === "Computed")!;
    expect(classExtendsElement(only)).toBeUndefined();
    const base = classExtendsElement(derived)!;
    expect(ts.isPropertyAccessExpression(base.expression)).toBe(true);
    expect(base.expression.getText()).toBe("Shapes.Base");
    expect(ts.isCallExpression(classExtendsElement(computed)!.expression)).toBe(true);
    const variable = file.statements.find(ts.isVariableStatement)!;
    const selected = variable.declarationList.declarations[0]!.initializer!;
    expect(ts.isClassExpression(selected)).toBe(true);
    if (ts.isClassExpression(selected)) expect(classExtendsElement(selected)!.expression.getText()).toBe("Shapes.Base");
    const child = file.statements.find(ts.isInterfaceDeclaration)!;
    for (const element of [child.heritageClauses![0]!.types[0]!, only.heritageClauses![0]!.types[0]!]) {
      const name = heritageTypeName(element)!;
      expect(name.text).toBe("Ready");
      expect(program.getTypeChecker().getSymbolAtLocation(name)?.name).toBe("Ready");
    }
    // Ordinary type references exercise the representation now used by TS7
    // for type-only heritage, without fabricating AST objects or enum values.
    const aliases = file.statements.filter(ts.isTypeAliasDeclaration);
    expect(aliases.map((alias) => heritageTypeName(alias.type)?.text)).toEqual(["Ready", "Child"]);
    expect(heritageTypeName(base)?.text).toBe("Base");
    expect(heritageTypeName(classExtendsElement(computed)!)).toBeUndefined();
  } finally {
    program.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
