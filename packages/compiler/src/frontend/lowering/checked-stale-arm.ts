import * as ts from "../ts7/adapter.js";
import { BOOL, isUnitType, typeEquals, type IrExpr, type IrType } from "../../ir/ir.js";
import { nodeThrowExpr, type Lowerer } from "./lowerer.js";
import { pureReemittable } from "./lower-exprs.js";

export const OTHER_ARM_FAILURE_MESSAGE =
  "a value of another type is not representable in the target union (a value narrowed or asserted past it still held it)";

/** checkedNarrowCall's in-place form with the TypeError of the consuming
 * operation: `messageFor` names Node's error for finding another arm
 * (`o.f is not a function`), or null for the stranded-value message. Null
 * when the operand cannot be evaluated more than once.
 *
 * The failure path stays small for wide unions: arms are grouped by their
 * message (every non-nullish arm without its own shares one), so it tests
 * at most the null and undefined arms before a final throw. */
export function checkedArmExtraction(
  lowerer: Lowerer,
  value: IrExpr,
  tag: number,
  arm: IrType,
  messageFor: (found: IrType) => string | null,
): IrExpr | null {
  if (value.type.kind !== "union" || !pureReemittable(value)) return null;
  const unionId = value.type.unionId;
  const from = lowerer.unions.get(unionId);
  const stored = from?.arms[tag];
  if (!from || from.arms.length < 2 || !stored || !typeEquals(stored, arm)) return null;
  const loc = value.loc;
  const isTag = (t: number): IrExpr => ({
    kind: "unionIsTag",
    unionId,
    tag: t,
    negated: false,
    value,
    type: BOOL,
    loc,
  });
  const groups = new Map<string, number[]>();
  from.arms.forEach((found, t) => {
    if (t === tag) return;
    const message =
      messageFor(found) ??
      (isUnitType(found)
        ? `${found.kind === "undefinedT" ? "undefined" : "null"} is not representable in the target union (a value narrowed or asserted past it still held it)`
        : OTHER_ARM_FAILURE_MESSAGE);
    const tags = groups.get(message);
    if (tags) tags.push(t);
    else groups.set(message, [t]);
  });
  // The largest group needs no test of its own: it is whatever remains.
  const ordered = [...groups].sort((a, b) => a[1].length - b[1].length);
  const [lastMessage] = ordered.pop()!;
  let failure: IrExpr = nodeThrowExpr(1, "", lastMessage, arm, loc);
  for (const [message, tags] of ordered.reverse()) {
    let cond = isTag(tags[0]!);
    for (const t of tags.slice(1))
      cond = { kind: "logical", op: "||", left: cond, right: isTag(t), type: BOOL, loc };
    const thrown = nodeThrowExpr(1, "", message, arm, loc);
    failure = { kind: "ternary", cond, then: thrown, else_: failure, type: arm, loc };
  }
  return {
    kind: "ternary",
    cond: isTag(tag),
    then: { kind: "unionNarrow", unionId, tag, value, type: arm, loc },
    else_: failure,
    type: arm,
    loc,
  };
}


export function checkedStaleArm(
  lowerer: Lowerer,
  node: ts.Node,
  value: IrExpr,
  tag: number,
  arm: IrType,
  narrowed: IrType = arm,
): IrExpr | null {
  if (value.type.kind !== "union" || tag < 0) return null;
  if (!lowerer.narrowing.untrusted(node, narrowed)) return null;
  const inPlace = checkedArmExtraction(lowerer, value, tag, arm, (found) =>
    staleReadMessage(node, found),
  );
  if (inPlace) return inPlace;
  const helper = lowerer.narrowedArmHelper(value.type.unionId, arm, value.loc);
  return helper ? { kind: "call", callee: helper, args: [value], type: arm, loc: value.loc } : null;
}

/** Node's TypeError for the operation consuming `node` when it holds a
 * value of type `found`, or null where Node would not throw. */
function staleReadMessage(node: ts.Node, found: IrType): string | null {
  let child: ts.Node = node;
  let parent = node.parent;
  while (ts.isParenthesizedExpression(parent)) {
    child = parent;
    parent = parent.parent;
  }
  if (ts.isCallExpression(parent) && parent.expression === child && !parent.questionDotToken) {
    return found.kind === "func" ? null : `${node.getText()} is not a function`;
  }
  const unit = found.kind === "undefinedT" ? "undefined" : found.kind === "nullT" ? "null" : null;
  if (unit === null) return null;
  if (
    !(ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) ||
    parent.expression !== child ||
    parent.questionDotToken
  )
    return null;
  let key: string | null = null;
  if (ts.isPropertyAccessExpression(parent)) key = parent.name.text;
  else if (ts.isStringLiteral(parent.argumentExpression)) key = parent.argumentExpression.text;
  else if (ts.isNumericLiteral(parent.argumentExpression))
    key = String(Number(parent.argumentExpression.text));
  if (key === null) return null;
  const store = parent.parent;
  return ts.isBinaryExpression(store) &&
    store.left === parent &&
    store.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ? `Cannot set properties of ${unit} (setting '${key}')`
    : `Cannot read properties of ${unit} (reading '${key}')`;
}
