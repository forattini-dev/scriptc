import * as ts from "../ts7/adapter.js";
import { type IrType } from "../../ir/ir.js";
import { isJsSourceFile } from "../program.js";
import type { Lowerer } from "./lowerer.js";

/** An unannotated JS factory can have no mapped checker signature while its
 * native closure ABI is fully known. Reserve module storage for that closure
 * so separately lowered constructors and methods can call the same value. */
export function jsFactoryGlobalType(lowerer: Lowerer, decl: ts.VariableDeclaration): (IrType & { kind: "func" }) | null {
  if (!isJsSourceFile(decl.getSourceFile()) || !ts.isIdentifier(decl.name) || decl.type !== undefined ||
    (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) === 0 || !decl.initializer) return null;
  let initializer = decl.initializer;
  while (ts.isParenthesizedExpression(initializer)) initializer = initializer.expression;
  if ((!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer)) ||
    initializer.type !== undefined || initializer.typeParameters !== undefined ||
    initializer.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    (ts.isFunctionExpression(initializer) && initializer.asteriskToken !== undefined) ||
    initializer.parameters.some(parameter => parameter.type !== undefined || parameter.questionToken !== undefined ||
      parameter.initializer !== undefined || parameter.dotDotDotToken !== undefined || !ts.isIdentifier(parameter.name))) return null;
  const { funcType } = lowerer.lambdaSignature(initializer);
  return funcType.ret.kind === "dyn" ? funcType : null;
}
