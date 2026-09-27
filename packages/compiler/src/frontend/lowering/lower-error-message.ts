import * as ts from "../ts7/adapter.js";
import { BOOL, DYN, STRING, type IrExpr, type IrStmt, type SrcLoc } from "../../ir/ir.js";
import { nodeThrowExpr, type Lowerer } from "./lowerer.js";
import { lowerDynObjectLiteral } from "./lower-exprs.js";

/** Error(message) and super(message) share ToString, except undefined is
 * the omitted-message case. The temporary keeps argument evaluation and
 * user coercion hooks single-shot. Only existing native dyn conversions
 * are admitted; unsupported carriers retain a compile-time fence. */
export function errorMessageArg(L: Lowerer, args: readonly ts.Expression[], loc: SrcLoc, blame: ts.Node): IrExpr {
  if (args.length > 1) L.unsupported("SC1090", args[1] ?? blame, "Error constructor options ('cause')");
  const empty: IrExpr = { kind: "strLit", value: "", type: STRING, loc };
  const node = args[0];
  if (node === undefined) return empty;
  return coerceErrorMessage(L, lowerInput(L, node), node, loc);
}

function lowerInput(L: Lowerer, node: ts.Expression): IrExpr {
  return ts.isObjectLiteralExpression(node) ? lowerDynObjectLiteral(L, node) : L.lowerExpr(node);
}

function coerceErrorMessage(L: Lowerer, value: IrExpr, node: ts.Expression, loc: SrcLoc): IrExpr {
  const empty: IrExpr = { kind: "strLit", value: "", type: STRING, loc };
  if (value.type.kind === "string") return value;
  if (value.kind === "unitLit" && value.unit === "undefined") return empty;
  if (value.type.kind === "symbol") {
    return { kind: "seqExpr", stmts: [{ kind: "exprStmt", expr: value, loc }],
      result: nodeThrowExpr(1, "", "Cannot convert a Symbol value to a string", STRING, loc), type: STRING, loc };
  }
  const dynamic: IrExpr | null = value.type.kind === "dyn" ? value
    : value.kind === "unitLit" || L.dynConvertible(value.type)
      ? { kind: "dynFrom", value, type: DYN, loc } : null;
  if (dynamic === null) L.unsupported("SC1090", node, `Error messages of type '${L.fmt(value.type)}' without a native ToString conversion`);
  const slot = L.declareHiddenLocal("%errorMessage", DYN);
  const ref: IrExpr = { kind: "varRef", localId: slot.id, type: DYN, loc };
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: slot.id, init: dynamic, loc }],
    result: {
      kind: "ternary",
      cond: { kind: "dynTest", test: "undefined", value: ref, type: BOOL, loc },
      then: empty,
      else_: { kind: "libCall", fn: "dyn.toStringCoerce", args: [ref], type: STRING, loc },
      type: STRING, loc,
    },
    type: STRING, loc,
  };
}

/** The inline cause expression is an argument-evaluation effect. It runs
 * AFTER the message expression but BEFORE ToString inside the constructor,
 * even if conversion throws. Keep both values before normalizing either. */
export function errorWithCause(L: Lowerer, message: ts.Expression, cause: ts.Expression, className: string, loc: SrcLoc): IrExpr {
  const raw = lowerInput(L, message);
  const input: IrExpr = raw.kind === "unitLit" ? { kind: "dynFrom", value: raw, type: DYN, loc } : raw;
  const causeValue = L.lowerExpr(cause);
  const dynCause = L.coerceToExpected(causeValue, DYN);
  if (dynCause.type.kind !== "dyn") {
    L.noLowering(`Error cause of type '${L.fmt(causeValue.type)}'`, cause,
      "unknown and checked-dynamic-convertible cause values lower");
  }
  const inputSlot = L.declareHiddenLocal("%errorMessageArgument", input.type);
  const causeSlot = L.declareHiddenLocal("%errorCauseArgument", DYN);
  const inputRef: IrExpr = { kind: "varRef", localId: inputSlot.id, type: input.type, loc };
  const causeRef: IrExpr = { kind: "varRef", localId: causeSlot.id, type: DYN, loc };
  const result: IrExpr = { kind: "libCall", fn: "error.newCause",
    args: [coerceErrorMessage(L, inputRef, message, loc), causeRef], type: { kind: "object", className }, loc };
  return { kind: "seqExpr", stmts: [
    { kind: "varDecl", localId: inputSlot.id, init: input, loc },
    { kind: "varDecl", localId: causeSlot.id, init: dynCause, loc },
  ], result, type: result.type, loc };
}

export interface ErrorSuperArgs {
  setup: IrStmt[];
  message: IrExpr;
  cause: IrExpr | null;
  hasCause: IrExpr | null;
}

/** The options forms admitted for `super(message, options)` in an Error
 * subclass. Besides the standard inline literal, TypeScript libraries often
 * preserve optionality as `x === undefined ? undefined : { cause: x }`.
 * The latter is folded only for a stable identifier/property-chain read, so
 * evaluating it once cannot skip a getter or another user hook. */
function superCauseOption(
  L: Lowerer,
  options: ts.Expression,
): { cause: ts.Expression; conditional: boolean } | null {
  const literalCause = (node: ts.Expression): ts.Expression | null => {
    if (!ts.isObjectLiteralExpression(node) || node.properties.length !== 1) return null;
    const property = node.properties[0]!;
    if (ts.isPropertyAssignment(property) &&
      ((ts.isIdentifier(property.name) && property.name.text === "cause") ||
        (ts.isStringLiteral(property.name) && property.name.text === "cause"))) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "cause") return property.name;
    return null;
  };
  const inline = literalCause(options);
  if (inline) return { cause: inline, conditional: false };
  if (!ts.isConditionalExpression(options)) return null;
  const whenTrueUndefined = ts.isIdentifier(options.whenTrue) && options.whenTrue.text === "undefined";
  const whenFalseUndefined = ts.isIdentifier(options.whenFalse) && options.whenFalse.text === "undefined";
  const objectCause = whenTrueUndefined ? literalCause(options.whenFalse) : whenFalseUndefined ? literalCause(options.whenTrue) : null;
  if (!objectCause || (!ts.isIdentifier(objectCause) && !ts.isPropertyAccessExpression(objectCause))) return null;
  const condition = options.condition;
  if (!ts.isBinaryExpression(condition)) return null;
  const equality = condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken;
  const inequality = condition.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  if (!equality && !inequality) return null;
  const candidate = ts.isIdentifier(condition.left) && condition.left.text === "undefined"
    ? condition.right
    : ts.isIdentifier(condition.right) && condition.right.text === "undefined"
      ? condition.left
      : null;
  if (!candidate || candidate.getText() !== objectCause.getText()) return null;
  const undefinedArmMatches = equality ? whenTrueUndefined : whenFalseUndefined;
  return undefinedArmMatches ? { cause: objectCause, conditional: true } : null;
}

/** Prepare a builtin Error super-call while preserving argument order:
 * message expression, options/cause expression, then message ToString. */
export function errorSuperArgs(L: Lowerer, args: readonly ts.Expression[], loc: SrcLoc, blame: ts.Node): ErrorSuperArgs {
  if (args.length <= 1) return { setup: [], message: errorMessageArg(L, args, loc, blame), cause: null, hasCause: null };
  if (args.length > 2) L.unsupported("SC1090", args[2] ?? blame, "Error constructor arguments after options");
  const option = superCauseOption(L, args[1]!);
  if (!option) L.unsupported("SC1090", args[1]!, "Error constructor options outside { cause: value } or the optional-cause conditional");
  const messageNode = args[0];
  const rawMessage = messageNode ? lowerInput(L, messageNode) : ({ kind: "unitLit", unit: "undefined", type: { kind: "undefinedT" }, loc } satisfies IrExpr);
  const messageInput = rawMessage.kind === "unitLit" ? { kind: "dynFrom", value: rawMessage, type: DYN, loc } satisfies IrExpr : rawMessage;
  const rawCause = L.lowerExpr(option.cause);
  const cause = L.coerceToExpected(rawCause, DYN);
  if (cause.type.kind !== "dyn") L.noLowering(`Error cause of type '${L.fmt(rawCause.type)}'`, option.cause, "unknown and checked-dynamic-convertible cause values lower");
  const messageSlot = L.declareHiddenLocal("%errorMessageArgument", messageInput.type);
  const causeSlot = L.declareHiddenLocal("%errorCauseArgument", DYN);
  const messageRef: IrExpr = { kind: "varRef", localId: messageSlot.id, type: messageInput.type, loc };
  const causeRef: IrExpr = { kind: "varRef", localId: causeSlot.id, type: DYN, loc };
  return {
    setup: [
      { kind: "varDecl", localId: messageSlot.id, init: messageInput, loc },
      { kind: "varDecl", localId: causeSlot.id, init: cause, loc },
    ],
    message: messageNode ? coerceErrorMessage(L, messageRef, messageNode, loc) : { kind: "strLit", value: "", type: STRING, loc },
    cause: causeRef,
    hasCause: option.conditional
      ? { kind: "dynTest", test: "undefined", negated: true, value: causeRef, type: BOOL, loc }
      : { kind: "boolLit", value: true, type: BOOL, loc },
  };
}
