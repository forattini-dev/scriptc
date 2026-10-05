import { BOOL, ERROR_TOSTRING_DISPATCH_FN, STRING, type IrExpr, type IrFunction, type IrStmt, type IrType, type SrcLoc } from "../../ir/ir.js";
import type { ClassInfo } from "./lower-classes.js";
import type { Lowerer } from "./lowerer.js";

const ERROR: IrType = { kind: "object", className: "%Error" };

/** More-specific overrides must precede ancestors. Builtin vtables have no
 * method slots, so dispatch uses existing instanceof intervals and direct
 * calls instead of an ordinary virtualCall through the runtime prefix. */
function overrides(lowerer: Lowerer): ClassInfo[] {
  const result: ClassInfo[] = [];
  const visit = (info: ClassInfo): void => {
    for (const child of info.subclasses) visit(child);
    if (!info.builtinError && info.methods.has("toString")) result.push(info);
  };
  const root = lowerer.classes.get("%Error");
  if (root) visit(root);
  return result;
}

function dispatchBody(candidates: readonly ClassInfo[], loc: SrcLoc): IrStmt[] {
  const value: IrExpr = { kind: "varRef", localId: "error.0", type: ERROR, loc };
  return [
    ...candidates.filter(info => info.methods.get("toString")?.abstract !== true).map((info): IrStmt => ({
      kind: "if",
      cond: { kind: "instanceOf", value, className: info.def.name, type: BOOL, loc },
      then: [{ kind: "return", value: {
        kind: "call", callee: `%${info.def.name}.toString`,
        args: [{ kind: "downcast", value, type: { kind: "object", className: info.def.name }, loc }],
        type: STRING, loc,
      }, loc }],
      else_: null, loc,
    })),
    { kind: "return", value: { kind: "libCall", fn: "error.toString", args: [value], type: STRING, loc }, loc },
  ];
}

function erasedDynBody(candidates: readonly ClassInfo[], stringConstructor: boolean, loc: SrcLoc, method = false): IrStmt[] {
  const value: IrExpr = { kind: "varRef", localId: "value.0", type: { kind: "dyn" }, loc };
  const error: IrExpr = { kind: "dynCheck", value, type: ERROR, loc };
  const methodCall: IrExpr = { kind: "libCall", fn: "dyn.toString", args: [
    value,
    { kind: "varRef", localId: "encoding.1", type: STRING, loc },
    { kind: "varRef", localId: "spelling.2", type: STRING, loc },
  ], type: STRING, loc };
  const fallback: IrExpr = method ? methodCall : stringConstructor
    ? { kind: "libCall", fn: "dyn.stringConstructor", args: [value], type: STRING, loc }
    : { kind: "toString", operand: value, type: STRING, loc };
  return [
    { kind: "if", cond: { kind: "dynTest", value, test: "error", type: BOOL, loc }, then: [
      // Own properties shadow the inherited method, including non-callable
      // shadows. Let the existing primitive-coercion protocol handle them.
      { kind: "if", cond: { kind: "libCall", fn: "dyn.hasOwn", args: [value, { kind: "strLit", value: "toString", type: STRING, loc }], type: BOOL, loc }, then: [
        { kind: "return", value: method ? methodCall : { kind: "libCall", fn: stringConstructor ? "dyn.stringConstructor" : "dyn.toStringCoerce", args: [value], type: STRING, loc }, loc },
      ], else_: null, loc },
      ...candidates.filter(info => info.methods.get("toString")?.abstract !== true).map((info): IrStmt => ({
        kind: "if", cond: { kind: "instanceOf", value: error, className: info.def.name, type: BOOL, loc }, then: [
          { kind: "return", value: { kind: "call", callee: ERROR_TOSTRING_DISPATCH_FN, args: [error], type: STRING, loc }, loc },
        ], else_: null, loc,
      })),
      // A builtin/non-overridden Error must use the dynamic snapshot: writes
      // through the boxed value need not have updated its native prefix.
      { kind: "return", value: { kind: "toString", operand: value, type: STRING, loc }, loc },
    ], else_: null, loc },
    { kind: "return", value: fallback, loc },
  ];
}

/** Ordinary Error calls/coercions honor overrides; lexical super calls keep
 * using the raw builtin libCall. Register implementation edges even when
 * another call site already created the shared dispatcher. */
export function lowerErrorToString(lowerer: Lowerer, value: IrExpr): IrExpr {
  const candidates = overrides(lowerer);
  const receiver = lowerer.upcastTo(value, "%Error");
  for (const info of candidates) {
    if (info.methods.get("toString")?.abstract !== true) lowerer.noteEdge(`%${info.def.name}.toString`);
  }
  if (!lowerer.arrHofHelpers.has(ERROR_TOSTRING_DISPATCH_FN)) {
    lowerer.arrHofHelpers.set(ERROR_TOSTRING_DISPATCH_FN, ERROR_TOSTRING_DISPATCH_FN);
    const helper: IrFunction = {
      name: ERROR_TOSTRING_DISPATCH_FN,
      params: [{ localId: "error.0", name: "error", type: ERROR }],
      returnType: STRING,
      locals: [{ id: "error.0", name: "error", type: ERROR, mutable: false }],
      body: dispatchBody(candidates, value.loc), loc: value.loc,
    };
    lowerer.liftedFns.push(helper);
  }
  return { kind: "call", callee: ERROR_TOSTRING_DISPATCH_FN, args: [receiver], type: STRING, loc: value.loc };
}

/** Catch bindings and checked-dynamic values retain the original Error in
 * their identity cache. Keep their non-Error coercion rules unchanged. */
export function lowerErasedErrorToString(lowerer: Lowerer, value: IrExpr, stringConstructor = false, methodArguments?: readonly [IrExpr, IrExpr]): IrExpr | null {
  if (value.type.kind !== "caught" && value.type.kind !== "dyn") return null;
  // Catch snapshots are local-only IR values: they cannot cross a function
  // boundary. The binding is an immutable varRef, so an inline guard reads
  // the same snapshot without evaluating the source expression twice.
  if (value.type.kind === "caught") {
    const error: IrExpr = { kind: "caughtNarrow", value, type: ERROR, loc: value.loc };
    return {
      kind: "ternary",
      cond: { kind: "caughtTest", value, test: "instanceof", className: "%Error", type: BOOL, loc: value.loc },
      then: lowerErrorToString(lowerer, error),
      else_: { kind: "toString", operand: value, type: STRING, loc: value.loc },
      type: STRING, loc: value.loc,
    };
  }
  const key = `%error.toString.${value.type.kind}${methodArguments ? ".method" : stringConstructor ? ".String" : ""}`;
  const ref: IrExpr = { kind: "varRef", localId: "value.0", type: value.type, loc: value.loc };
  const error: IrExpr = { kind: "dynCheck", value: ref, type: ERROR, loc: value.loc };
  lowerErrorToString(lowerer, error);
  if (!lowerer.arrHofHelpers.has(key)) {
    lowerer.arrHofHelpers.set(key, key);
    const params = [
      { localId: "value.0", name: "value", type: value.type },
      ...(methodArguments ? [
        { localId: "encoding.1", name: "encoding", type: STRING },
        { localId: "spelling.2", name: "spelling", type: STRING },
      ] : []),
    ];
    lowerer.liftedFns.push({
      name: key, params, returnType: STRING,
      locals: params.map(param => ({ id: param.localId, name: param.name, type: param.type, mutable: false })),
      body: erasedDynBody(overrides(lowerer), stringConstructor, value.loc, methodArguments !== undefined),
      loc: value.loc,
    });
  }
  return { kind: "call", callee: key, args: [value, ...(methodArguments ?? [])], type: STRING, loc: value.loc };
}

/** Generic/class-expression instantiations can collect after the first
 * coercion site. Their members are emitted by the instance worklist; keep
 * the final dispatch table in sync with the completed class graph. */
export function refreshErrorToStringDispatch(lowerer: Lowerer): void {
  if (!lowerer.arrHofHelpers.has(ERROR_TOSTRING_DISPATCH_FN)) return;
  const candidates = overrides(lowerer);
  for (const info of candidates) {
    if (info.methods.get("toString")?.abstract !== true) lowerer.noteEdge(`%${info.def.name}.toString`);
  }
  const helper = lowerer.liftedFns.find(fn => fn.name === ERROR_TOSTRING_DISPATCH_FN);
  if (helper) helper.body = dispatchBody(candidates, helper.loc);
  for (const erased of lowerer.liftedFns) {
    if (erased.name === "%error.toString.dyn" || erased.name === "%error.toString.dyn.String" || erased.name === "%error.toString.dyn.method") {
      erased.body = erasedDynBody(candidates, erased.name.endsWith(".String"), erased.loc, erased.name.endsWith(".method"));
    }
  }
}
