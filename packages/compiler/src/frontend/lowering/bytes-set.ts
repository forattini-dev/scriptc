import * as ts from "../ts7/adapter.js";
import { BOOL, F64, VOID, isUnitType, typeEquals, type IrExpr, type IrStmt, type IrType } from "../../ir/ir.js";
import { numLit, varRef } from "../../ir/build.js";
import { locOf } from "../program.js";
import { nodeThrowExpr, type Lowerer } from "./lowerer.js";
import { lowerBytesSetCall } from "./lower-native-containers.js";

/** Sources that copy element by element: number[], array literals and
 * homogeneous numeric tuples. The checker's type decides, before any operand
 * lowers, so the numeric-sequence path never lowers an operand twice. */
function isNumericSequenceSource(L: Lowerer, node: ts.Expression): boolean {
  if (ts.isArrayLiteralExpression(node) && !node.elements.some(ts.isSpreadElement)) return true;
  const type = L.mapTypeOf(L.typeOf(node));
  if (type?.kind === "array") return type.elem.kind === "f64";
  if (type?.kind !== "record") return false;
  const shape = L.shapes.get(type.shapeId);
  return shape?.tuple === true && shape.fields.every((field) => field.type.kind === "f64");
}

/** TypedArray.set: a same-kind typed array copies in, number[] and numeric
 * tuples convert element by element (lowerBytesSetCall), and a Rust-only
 * presence-aware source path serves array iteration. Other forms still refuse. */
export function lowerSameKindBytesSetCall(
  L: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  expected: IrType & { kind: "bytes" },
): IrExpr {
  const loc = locOf(call);
  if (call.arguments.length < 1 || call.arguments.length > 2) {
    L.noLowering(`.set with ${call.arguments.length} arguments on typed arrays`, call);
  }
  if (isNumericSequenceSource(L, call.arguments[0]!)) return lowerBytesSetCall(L, call, access, expected);
  const receiver = L.lowerExpr(access.expression);
  const source = L.lowerExpr(call.arguments[0]!);
  const optional = lowerOptionalBytesSet(L, call, receiver, source, expected);
  if (optional) return optional;
  if (!typeEquals(source.type, expected)) {
    L.noLowering(
      `.set from '${L.fmt(source.type)}' values`,
      call.arguments[0]!,
      "supported sources are a same-kind typed array, number[] or a numeric tuple (narrow unions first)",
    );
  }
  const args = [source];
  if (call.arguments[1]) args.push(L.lowerExprExpecting(call.arguments[1], F64));
  return { kind: "bytesIntrinsic", method: "setFrom", receiver, args, type: VOID, loc };
}

/** TypedArray.set evaluates every argument before converting an absent
 * array-derived source to an object. A negative integer offset wins over
 * that TypeError; positive infinity does not. Keep the dense-array ABI. */
function lowerOptionalBytesSet(
  L: Lowerer,
  call: ts.CallExpression,
  receiver: IrExpr,
  source: IrExpr,
  expected: IrType & { kind: "bytes" },
): IrExpr | null {
  if (!L.nativeDenseArrays || source.type.kind !== "union") return null;
  const unionId = source.type.unionId;
  const def = L.unions.get(unionId);
  const tag = L.armTag(unionId, expected);
  if (!def || tag < 0 || !def.arms.every((arm) => typeEquals(arm, expected) || isUnitType(arm))) return null;

  const loc = locOf(call);
  const offset = call.arguments[1] ? L.lowerExprExpecting(call.arguments[1], F64) : numLit(0, loc);
  const destination = L.declareHiddenLocal("%bytesSetRecv", expected);
  const input = L.declareHiddenLocal("%bytesSetSource", source.type);
  const position = L.declareHiddenLocal("%bytesSetOffset", F64);
  const sourceRef = (): IrExpr => varRef(input.id, source.type, loc);
  const offsetRef = (): IrExpr => varRef(position.id, F64, loc);
  const stmts: IrStmt[] = [
    { kind: "varDecl", localId: destination.id, init: receiver, loc },
    { kind: "varDecl", localId: input.id, init: source, loc },
    { kind: "varDecl", localId: position.id, init: offset, loc },
    {
      kind: "if",
      cond: {
        kind: "bin", op: "<",
        left: { kind: "libCall", fn: "math.trunc", args: [offsetRef()], type: F64, loc },
        right: numLit(0, loc), type: BOOL, loc,
      },
      then: [{ kind: "exprStmt", expr: nodeThrowExpr(2, "", "offset is out of bounds", VOID, loc), loc }],
      else_: null, loc,
    },
  ];
  for (let index = def.arms.length - 1; index >= 0; index--) {
    if (!isUnitType(def.arms[index]!)) continue;
    stmts.push({
      kind: "if",
      cond: { kind: "unionIsTag", unionId, tag: index, value: sourceRef(), negated: false, type: BOOL, loc },
      then: [{ kind: "exprStmt", expr: nodeThrowExpr(1, "", "Cannot convert undefined or null to object", VOID, loc), loc }],
      else_: null, loc,
    });
  }
  return {
    kind: "seqExpr",
    stmts,
    result: {
      kind: "bytesIntrinsic", method: "setFrom",
      receiver: varRef(destination.id, expected, loc),
      args: [{ kind: "unionNarrow", unionId, tag, value: sourceRef(), type: expected, loc }, offsetRef()],
      type: VOID, loc,
    },
    type: VOID, loc,
  };
}
