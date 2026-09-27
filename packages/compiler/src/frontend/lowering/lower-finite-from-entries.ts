/* Exact-record lowering for Object.fromEntries over an immutable finite key
 * table. The map executes normally and in source order; only the final
 * materialization changes from an open index record to a fixed Rust record. */
import * as ts from "../ts7/adapter.js";
import { numLit, varRef } from "../../ir/build.js";
import type { IrExpr, IrType } from "../../ir/ir.js";
import { STRING } from "../../ir/ir.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";

const SAFE_ARRAY_READS = new Set(["map", "reduce"]);

function finiteStringKeys(
  lowerer: Lowerer,
  receiver: ts.Expression,
): string[] | null {
  if (!ts.isIdentifier(receiver)) return null;
  const symbol = lowerer.resolveValueSymbol(receiver);
  const declarations = symbol ? lowerer.checker.declarationsOf(symbol) : [];
  if (!symbol || declarations.length !== 1 || !ts.isVariableDeclaration(declarations[0]!)) return null;
  const declaration = declarations[0];
  if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) return null;
  const statement = declaration.parent;
  if (!ts.isVariableDeclarationList(statement) || (statement.flags & ts.NodeFlags.Const) === 0) return null;
  let initializer: ts.Expression = declaration.initializer;
  while (ts.isParenthesizedExpression(initializer)) initializer = initializer.expression;
  if (!ts.isArrayLiteralExpression(initializer) || initializer.elements.some(ts.isSpreadElement)) return null;
  const keys: string[] = [];
  for (const element of initializer.elements) {
    if (!ts.isStringLiteral(element)) return null;
    keys.push(element.text);
  }
  if (keys.length === 0 || new Set(keys).size !== keys.length) return null;

  // Const protects the binding, not the array. Admit only receiver uses of
  // read-only methods whose calls cannot leak the array reference. Any alias,
  // argument, return, indexed access or unknown property conservatively
  // declines the exact-shape proof.
  let safe = true;
  const visit = (node: ts.Node): void => {
    if (!safe) return;
    if (ts.isIdentifier(node) && node !== declaration.name && node.text === symbol.name && lowerer.resolveValueSymbol(node) === symbol) {
      const access = node.parent;
      const call = access && ts.isPropertyAccessExpression(access) && access.expression === node ? access.parent : undefined;
      const method = access && ts.isPropertyAccessExpression(access) ? access.name.text : "";
      const callback = call && ts.isCallExpression(call) ? call.arguments[0] : undefined;
      const callbackCannotReceiveArray =
        callback !== undefined && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
        (method === "map" ? callback.parameters.length <= 2 : method === "reduce" && callback.parameters.length <= 3);
      if (
        !access || !ts.isPropertyAccessExpression(access) || access.expression !== node ||
        !call || !ts.isCallExpression(call) || call.expression !== access || call.questionDotToken !== undefined ||
        !SAFE_ARRAY_READS.has(method) || !callbackCannotReceiveArray
      ) safe = false;
    }
    node.forEachChild(visit);
  };
  declaration.getSourceFile().forEachChild(visit);
  return safe ? keys : null;
}

export function lowerFiniteFromEntriesExpecting(
  lowerer: Lowerer,
  node: ts.Expression,
  expected: IrType & { kind: "record" },
): IrExpr | null {
  if (!ts.isCallExpression(node) || node.questionDotToken || node.arguments.length !== 1) return null;
  const fromEntries = node.expression;
  if (
    !ts.isPropertyAccessExpression(fromEntries) || fromEntries.questionDotToken ||
    fromEntries.name.text !== "fromEntries" || !lowerer.isStdlibGlobal(fromEntries.expression, "Object")
  ) return null;
  const mapCall = node.arguments[0]!;
  if (!ts.isCallExpression(mapCall) || mapCall.questionDotToken || mapCall.arguments.length !== 1) return null;
  const mapAccess = mapCall.expression;
  if (!ts.isPropertyAccessExpression(mapAccess) || mapAccess.questionDotToken || mapAccess.name.text !== "map") return null;
  const finite = finiteStringKeys(lowerer, mapAccess.expression);
  if (finite === null) return null;

  const callback = mapCall.arguments[0]!;
  if (
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) || callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    callback.parameters.length !== 1 || !ts.isIdentifier(callback.parameters[0]!.name)
  ) return null;
  const returned = ts.isBlock(callback.body)
    ? callback.body.statements.length === 1 && ts.isReturnStatement(callback.body.statements[0]!)
      ? callback.body.statements[0]!.expression
      : undefined
    : callback.body;
  if (
    !returned || !ts.isArrayLiteralExpression(returned) || returned.elements.length !== 2 ||
    returned.elements.some((element) => ts.isSpreadElement(element) || ts.isOmittedExpression(element))
  ) return null;
  const keyExpression = returned.elements[0]!;
  const parameterSymbol = lowerer.checker.getSymbolAtLocation(callback.parameters[0]!.name);
  if (!ts.isIdentifier(keyExpression) || lowerer.checker.getSymbolAtLocation(keyExpression) !== parameterSymbol) return null;

  const expectedShape = lowerer.shapes.get(expected.shapeId);
  if (!expectedShape || expectedShape.tuple || expectedShape.indexValue || expectedShape.fields.length !== finite.length) return null;
  const keyIndexes = new Map(finite.map((key, index) => [key, index]));
  if (expectedShape.fields.some((field) => !keyIndexes.has(field.name))) return null;

  const pairs = lowerer.lowerExpr(mapCall);
  if (pairs.type.kind !== "array" || pairs.type.elem.kind !== "record") return null;
  const pairsType = pairs.type;
  const tupleType = pairsType.elem as IrType & { kind: "record" };
  const tupleShape = lowerer.shapes.get(tupleType.shapeId);
  if (!tupleShape?.tuple || tupleShape.fields.length !== 2) return null;
  const keyField = tupleShape.fields.find((field) => field.name === "0");
  const valueField = tupleShape.fields.find((field) => field.name === "1");
  if (!keyField || keyField.type.kind !== STRING.kind || !valueField) return null;

  const loc = locOf(node);
  const local = lowerer.declareHiddenLocal("%finiteFromEntries", pairsType);
  const pairsRef = varRef(local.id, pairsType, loc);
  const fields = expectedShape.fields.map((field) => {
    const index = keyIndexes.get(field.name)!;
    const pair: IrExpr = {
      kind: "arrayGet",
      arr: pairsRef,
      index: numLit(index, loc),
      type: tupleType,
      loc,
    };
    const value: IrExpr = {
      kind: "recordGet",
      obj: pair,
      shapeId: tupleType.shapeId,
      field: "1",
      type: valueField.type,
      loc,
    };
    return { name: field.name, value: lowerer.coerceInto(returned.elements[1]!, value, field.type) };
  });
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: local.id, init: pairs, loc }],
    result: { kind: "recordLit", fields, type: expected, loc },
    type: expected,
    loc,
  };
}
