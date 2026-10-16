import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { Checker, Type } from "typescript/unstable/sync";
import * as ts from "./adapter.js";
import { CheckerFacade, constituentTypes } from "./checker.js";
import { Ts7Host } from "./program-adapter.js";

test("materialized declarations retain source identity across symbols and signatures", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-checker-declarations-"));
  const entry = join(dir, "main.ts");
  writeFileSync(entry, `
    interface Merged { value: number }
    interface Merged { label: string }
    function identity<T>(value: T): T { return value; }
    const inferred = (value: number) => value;
  `);
  const program = ts.createProgram([entry], { noLib: true });
  try {
    const file = program.getSourceFile(entry)!;
    const checker = program.getTypeChecker();
    const interfaces = file.statements.filter(ts.isInterfaceDeclaration);
    const symbol = checker.getSymbolAtLocation(interfaces[0]!.name)!;
    const declarations = checker.declarationsOf(symbol);
    expect(declarations).toHaveLength(2);
    expect(declarations[0]).toBe(interfaces[0]);
    expect(declarations[1]).toBe(interfaces[1]);
    expect(checker.declarationsOf(symbol)).toBe(declarations);
    expect(checker.valueDeclarationOf(symbol)).toBeUndefined();
    const fn = file.statements.find(ts.isFunctionDeclaration)!;
    const fnSymbol = checker.getSymbolAtLocation(fn.name!)!;
    expect(checker.valueDeclarationOf(fnSymbol)).toBe(fn);
    expect(checker.declarationsOf(fnSymbol)[0]).toBe(fn);
    const signature = checker.getSignatureFromDeclaration(fn)!;
    expect(checker.signatureDeclaration(signature)).toBe(fn);
    expect(checker.signatureDeclaration(signature)).toBe(fn);
    const variable = file.statements.find(ts.isVariableStatement)!.declarationList.declarations[0]!;
    const arrow = variable.initializer!;
    const callable = checker.getCallSignatures(checker.getTypeAtLocation(variable.name))[0]!;
    expect(checker.signatureDeclaration(callable)).toBe(arrow);
  } finally {
    program.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("empty tuple references retain their union arms and instantiated element types", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-empty-tuple-reference-"));
  const entry = join(dir, "main.ts");
  writeFileSync(entry, `
    type Empty = readonly [];
    type Pair = readonly [string, number];
    type Either = Empty | Pair;
    function pairs(lines: string[]): [string, string][] {
      return lines.flatMap(line => {
        const at = line.indexOf("=");
        return at < 0 ? [] : [[line.slice(0, at), line.slice(at + 1)]];
      });
    }
  `);
  const host = new Ts7Host({ cwd: dir });
  const program = host.createProgram([entry], { strict: true, target: ts.ScriptTarget.ESNext });
  try {
    expect(program.getSemanticDiagnostics()).toEqual([]);
    const file = program.getSourceFile(entry)!;
    const checker = program.getTypeChecker();
    const aliases = file.statements.filter(ts.isTypeAliasDeclaration);
    const either = checker.getTypeFromTypeNode(aliases.find(alias => alias.name.text === "Either")!.type);
    const arms = constituentTypes(either);
    expect(arms).toHaveLength(2);
    expect(arms.map(arm => checker.getTypeArguments(arm as ts.TypeReference).length).sort()).toEqual([0, 2]);
    for (const arm of arms) {
      expect(checker.isTupleType(arm)).toBe(true);
      expect(arm.flags & ts.TypeFlags.Any).toBe(0);
    }
    ts.walkPreorder(file, node => {
      if (ts.isArrayLiteralExpression(node) && node.elements.length === 0) {
        const type = checker.raw.getTypeAtLocation(node);
        expect(type).toBeDefined();
        if (!type) throw new Error("empty array type was lost");
        expect(type.flags & ts.TypeFlags.Any).toBe(0);
      }
    });
  } finally {
    program.dispose(); host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assignability caches true and false by ordered pair and retries failed queries", () => {
  const source = {} as Type, target = {} as Type;
  const query = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false)
    .mockImplementationOnce(() => { throw new Error("server failure"); }).mockReturnValueOnce(true);
  const raw = { isTypeAssignableTo: query } as unknown as Checker;
  const checker = new CheckerFacade(raw);
  expect(checker.isTypeAssignableTo(source, target)).toBe(true);
  expect(checker.isTypeAssignableTo(source, target)).toBe(true);
  expect(checker.isTypeAssignableTo(target, source)).toBe(false);
  expect(checker.isTypeAssignableTo(target, source)).toBe(false);
  expect(query.mock.calls).toEqual([[source, target], [target, source]]);
  const sibling = new CheckerFacade(raw);
  expect(() => sibling.isTypeAssignableTo(source, target)).toThrow("server failure");
  expect(sibling.isTypeAssignableTo(source, target)).toBe(true);
  expect(query).toHaveBeenCalledTimes(4);
});

test("real TS7 assignability preserves literals, optional fields, variance and private members", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-checker-assignability-"));
  const entry = join(dir, "main.ts");
  writeFileSync(entry, `
    type Wide = { kind: "left" | "right"; value: number };
    type Left = { kind: "left"; value: number };
    type Optional = { kind: "left"; value: number; extra?: number };
    type Required = { kind: "left"; value: number; extra: number };
    type WideFn = (value: Wide) => number;
    type LeftFn = (value: Left) => number;
    class First { private token = 1; }
    class Second { private token = 1; }
    type FirstType = First;
    type SecondType = Second;
  `);
  const host = new Ts7Host({ cwd: dir });
  const program = host.createProgram([entry], { strict: true, noLib: true });
  try {
    const file = program.getSourceFile(entry)!;
    const checker = program.getTypeChecker();
    const types = new Map(file.statements.filter(ts.isTypeAliasDeclaration)
      .map((alias) => [alias.name.text, checker.getTypeFromTypeNode(alias.type)]));
    const query = vi.spyOn(checker.raw, "isTypeAssignableTo");
    for (const [from, to, expected] of [
      ["Left", "Wide", true], ["Wide", "Left", false],
      ["Left", "Optional", true], ["Optional", "Required", false],
      ["Required", "Optional", true], ["WideFn", "LeftFn", true],
      ["LeftFn", "WideFn", false], ["FirstType", "SecondType", false],
    ] as const) {
      expect(checker.isTypeAssignableTo(types.get(from)!, types.get(to)!)).toBe(expected);
      expect(checker.isTypeAssignableTo(types.get(from)!, types.get(to)!)).toBe(expected);
    }
    expect(query).toHaveBeenCalledTimes(8);
  } finally {
    program.dispose();
    host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
