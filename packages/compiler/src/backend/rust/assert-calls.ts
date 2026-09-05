// The assert.* library calls (node:assert's static ladder): split from
// lib-calls.ts so the dispatcher stays under the file-line cap.
import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";
import { RUNTIME_ERROR_CLASSES } from "../../ir/nodes.js";

export function emitRustAssertCall(
  expr: RustLibCallExpr,
  context: RustLibCallContext,
): string | null {
  const arg = expr.args[0];
  const secondArg = expr.args[1];
  if (expr.fn === "assert.eqDyn" && expr.args.length === 6 &&
    arg?.type.kind === "dyn" && secondArg?.type.kind === "dyn" &&
    expr.args[2]?.type.kind === "bool" && expr.args[3]?.type.kind === "bool" &&
    expr.args[4]?.type.kind === "string" && expr.args[5]?.type.kind === "bool") {
    const actual = context.nextTemporary();
    const expected = context.nextTemporary();
    const negated = context.nextTemporary();
    const deep = context.nextTemporary();
    const message = context.nextTemporary();
    const hasMessage = context.nextTemporary();
    return `{ let ${actual} = ${context.emitExpr(arg)}; let ${expected} = ${context.emitExpr(secondArg)}; let ${negated} = ${context.emitExpr(expr.args[2])}; let ${deep} = ${context.emitExpr(expr.args[3])}; let ${message} = ${context.emitExpr(expr.args[4])}; let ${hasMessage} = ${context.emitExpr(expr.args[5])}; sc_dyn_assert_message(&${actual}, &${expected}, ${negated}, ${deep}, &${message}, ${hasMessage}); () }`;
  }
  if (expr.fn === "assert.ok" && expr.args.length === 2 &&
    arg?.type.kind === "bool" && secondArg?.type.kind === "string") {
    return `runtime::assert_ok(${context.emitExpr(arg)}, &(${context.emitExpr(secondArg)}))`;
  }
  if ((expr.fn === "assert.eqF64" || expr.fn === "assert.eqStr" || expr.fn === "assert.eqBool") &&
    expr.args.length === 6 && arg !== undefined && secondArg !== undefined &&
    expr.args[2]?.type.kind === "bool" && expr.args[3]?.type.kind === "bool" &&
    expr.args[4]?.type.kind === "string" && expr.args[5]?.type.kind === "bool") {
    const helper = expr.fn === "assert.eqF64" ? "assert_eq_f64" :
      expr.fn === "assert.eqStr" ? "assert_eq_string" : "assert_eq_bool";
    const borrowed = expr.fn === "assert.eqStr";
    const value = (index: number): string => {
      const valueExpr = expr.args[index];
      if (valueExpr === undefined) context.unsupported(`${expr.fn} argument arity`, expr.loc);
      const emitted = context.emitExpr(valueExpr);
      return borrowed && index < 2 ? `&(${emitted})` : emitted;
    };
    return `runtime::${helper}(${value(0)}, ${value(1)}, ${value(2)}, ${value(3)}, &(${value(4)}), ${value(5)})`;
  }
  if (expr.fn === "assert.eqSym" && expr.args.length === 6 &&
    arg?.type.kind === "symbol" && secondArg?.type.kind === "symbol" &&
    expr.args[2]?.type.kind === "bool" && expr.args[3]?.type.kind === "bool" &&
    expr.args[4]?.type.kind === "string" && expr.args[5]?.type.kind === "bool") {
    return `runtime::assert_eq_symbol(&(${context.emitExpr(arg)}), &(${context.emitExpr(secondArg)}), ${context.emitExpr(expr.args[2])}, ${context.emitExpr(expr.args[3])}, &(${context.emitExpr(expr.args[4])}), ${context.emitExpr(expr.args[5])})`;
  }
  if (expr.fn === "assert.sameValue" && expr.args.length === 2 &&
    arg?.type.kind === "f64" && secondArg?.type.kind === "f64") {
    return `runtime::assert_same_value_f64(${context.emitExpr(arg)}, ${context.emitExpr(secondArg)})`;
  }
  if (expr.fn === "assert.bytesDeepEq" && expr.args.length === 3 &&
    arg?.type.kind === "bytes" && secondArg?.type.kind === "bytes" &&
    expr.args[2]?.type.kind === "bool") {
    return `(${context.emitExpr(expr.args[2])} && runtime::bytes_deep_equals(&(${context.emitExpr(arg)}), &(${context.emitExpr(secondArg)})))`;
  }
  if (expr.fn === "assert.refEqBytes" && expr.args.length === 6 &&
    arg?.type.kind === "bytes" && secondArg?.type.kind === "bytes" &&
    expr.args[2]?.type.kind === "bool" && expr.args[3]?.type.kind === "bool" &&
    expr.args[4]?.type.kind === "string" && expr.args[5]?.type.kind === "bool") {
    return `runtime::assert_ref_eq_bytes(&(${context.emitExpr(arg)}), &(${context.emitExpr(secondArg)}), ${context.emitExpr(expr.args[2])}, ${context.emitExpr(expr.args[3])}, &(${context.emitExpr(expr.args[4])}), ${context.emitExpr(expr.args[5])})`;
  }
  if (expr.fn === "assert.refEqFn" && expr.args.length === 5 &&
    arg?.type.kind === "func" && secondArg?.type.kind === "func" &&
    expr.args[2]?.type.kind === "bool" && expr.args[3]?.type.kind === "string" &&
    expr.args[4]?.type.kind === "bool") {
    const values = expr.args.map(() => context.nextTemporary());
    const bindings = expr.args.map((value, index) => `let ${values[index]} = ${context.emitExpr(value)};`).join(" ");
    const left = values[0];
    const right = values[1];
    if (left === undefined || right === undefined) context.unsupported("assert.refEqFn argument arity", expr.loc);
    return `{ ${bindings} runtime::assert_ref_eq_function(${context.functionIdentity(left, arg.type, expr.loc)}, ${context.functionIdentity(right, secondArg.type, expr.loc)}, ${values[2]}, &${values[3]}, ${values[4]}) }`;
  }
  if (expr.fn === "assert.match" && expr.args.length === 5 &&
    arg?.type.kind === "string" && secondArg?.type.kind === "regex" &&
    expr.args[2]?.type.kind === "bool" && expr.args[3]?.type.kind === "string" &&
    expr.args[4]?.type.kind === "bool") {
    return `runtime::assert_match(&(${context.emitExpr(arg)}), &(${context.emitExpr(secondArg)}), ${context.emitExpr(expr.args[2])}, &(${context.emitExpr(expr.args[3])}), ${context.emitExpr(expr.args[4])})`;
  }
  if (expr.fn === "assert.deqEnter" && expr.args.length === 2 && arg !== undefined && secondArg !== undefined) {
    const left = context.nextTemporary();
    const right = context.nextTemporary();
    return `{ let ${left} = ${context.emitExpr(arg)}; let ${right} = ${context.emitExpr(secondArg)}; runtime::assert_deep_pair_enter(${left}.identity(), ${right}.identity()) }`;
  }
  if (expr.fn === "assert.deqLeave" && expr.args.length === 0) {
    return "runtime::assert_deep_pair_leave()";
  }
  if (expr.fn === "assert.deepResult" && expr.args.length === 4 &&
    arg?.type.kind === "bool" && secondArg?.type.kind === "bool" &&
    expr.args[2]?.type.kind === "string" && expr.args[3]?.type.kind === "bool") {
    return `runtime::assert_deep_result(${context.emitExpr(arg)}, ${context.emitExpr(secondArg)}, &(${context.emitExpr(expr.args[2])}), ${context.emitExpr(expr.args[3])})`;
  }
  if (expr.fn === "assert.ifErrorErr" && expr.args.length === 1 && arg?.type.kind === "object") {
    const value = context.nextTemporary();
    const nameHelper = !context.hasErrorClassRoots() ? "runtime::error_name" : "sc_error_name";
    const messageHelper = !context.hasErrorClassRoots() ? "runtime::error_message" : "sc_error_message";
    return `{ let ${value} = ${context.emitExpr(arg)}; runtime::assert_if_error_parts(&${nameHelper}(&${value}), &${messageHelper}(&${value})) }`;
  }
  if (expr.fn === "assert.ifErrorF64" && expr.args.length === 1 && arg?.type.kind === "f64") {
    return `runtime::assert_if_error_f64(${context.emitExpr(arg)})`;
  }
  if (expr.fn === "assert.ifErrorStr" && expr.args.length === 1 && arg?.type.kind === "string") {
    return `runtime::assert_if_error_string(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "assert.ifErrorBool" && expr.args.length === 1 && arg?.type.kind === "bool") {
    return `runtime::assert_if_error_bool(${context.emitExpr(arg)})`;
  }
  if (expr.fn === "assert.ifErrorDyn" && expr.args.length === 1 && arg?.type.kind === "dyn") {
    return `sc_dyn_assert_if_error(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "assert.shapeBegin" && expr.args.length === 1 &&
    arg?.type.kind === "object" && RUNTIME_ERROR_CLASSES.has(arg.type.className)) {
    if (context.hasErrorClassRoots()) {
      context.unsupported("assertion shape over Error subclasses", expr.loc);
    }
    const value = context.nextTemporary();
    return `{ let ${value} = ${context.emitExpr(arg)}; runtime::assert_shape_begin(&${value}); () }`;
  }
  if (expr.fn === "assert.shapeStr" && expr.args.length === 2 &&
    arg?.type.kind === "f64" && secondArg?.type.kind === "string") {
    return `runtime::assert_shape_string(${context.emitExpr(arg)}, &(${context.emitExpr(secondArg)}))`;
  }
  if (expr.fn === "assert.shapeRe" && expr.args.length === 2 &&
    arg?.type.kind === "f64" && secondArg?.type.kind === "regex") {
    return `runtime::assert_shape_regex(${context.emitExpr(arg)}, &(${context.emitExpr(secondArg)}))`;
  }
  if (expr.fn === "assert.shapeEnd" && expr.args.length === 2 &&
    arg?.type.kind === "string" && secondArg?.type.kind === "bool") {
    return `runtime::assert_shape_end(&(${context.emitExpr(arg)}), ${context.emitExpr(secondArg)})`;
  }
  if (expr.fn === "assert.throwsNone" && expr.args.length === 5 &&
    arg !== undefined && secondArg !== undefined && expr.args[2] !== undefined &&
    expr.args[3] !== undefined && expr.args[4] !== undefined) {
    return `runtime::assert_throws_none(${context.emitExpr(arg)}, &(${context.emitExpr(secondArg)}), ${context.emitExpr(expr.args[2])}, &(${context.emitExpr(expr.args[3])}), ${context.emitExpr(expr.args[4])})`;
  }
  if (expr.fn === "assert.throwsMismatch" && expr.args.length === 4 &&
    arg !== undefined && secondArg?.type.kind === "object" && expr.args[2] !== undefined && expr.args[3] !== undefined) {
    const expected = context.nextTemporary();
    const error = context.nextTemporary();
    const message = context.nextTemporary();
    const hasMessage = context.nextTemporary();
    const nameHelper = !context.hasErrorClassRoots() ? "runtime::error_name" : "sc_error_name";
    const messageHelper = !context.hasErrorClassRoots() ? "runtime::error_message" : "sc_error_message";
    return `{ let ${expected} = ${context.emitExpr(arg)}; let ${error} = ${context.emitExpr(secondArg)}; let ${message} = ${context.emitExpr(expr.args[2])}; let ${hasMessage} = ${context.emitExpr(expr.args[3])}; runtime::assert_throws_mismatch(&${expected}, &${nameHelper}(&${error}), &${messageHelper}(&${error}), &${message}, ${hasMessage}) }`;
  }
  if (expr.fn === "assert.throwsRegex" && expr.args.length === 4 &&
    arg?.type.kind === "regex" && secondArg?.type.kind === "object" &&
    expr.args[2]?.type.kind === "string" && expr.args[3]?.type.kind === "bool") {
    const regex = context.nextTemporary();
    const error = context.nextTemporary();
    const message = context.nextTemporary();
    const hasMessage = context.nextTemporary();
    const toString = context.hasErrorClassRoots() ? "sc_error_to_string" : "runtime::error_to_string";
    return `{ let ${regex} = ${context.emitExpr(arg)}; let ${error} = ${context.emitExpr(secondArg)}; let ${message} = ${context.emitExpr(expr.args[2])}; let ${hasMessage} = ${context.emitExpr(expr.args[3])}; let sc_actual = ${toString}(&${error}); runtime::assert_throws_regex(&${regex}, &sc_actual, &${message}, ${hasMessage}) }`;
  }
  if (expr.fn === "assert.regexErrTest" && expr.args.length === 2 &&
    arg?.type.kind === "regex" && secondArg?.type.kind === "object") {
    const toString = context.hasErrorClassRoots() ? "sc_error_to_string" : "runtime::error_to_string";
    return `runtime::regex_hits(&(${context.emitExpr(arg)}), &${toString}(&(${context.emitExpr(secondArg)})))`;
  }
  if (expr.fn === "assert.unwantedRejection" && expr.args.length === 3 &&
    arg?.type.kind === "object" && secondArg?.type.kind === "string" &&
    expr.args[2]?.type.kind === "bool") {
    const messageHelper = context.hasErrorClassRoots() ? "sc_error_message" : "runtime::error_message";
    return `runtime::assert_unwanted_rejection(&${messageHelper}(&(${context.emitExpr(arg)})), &(${context.emitExpr(secondArg)}), ${context.emitExpr(expr.args[2])})`;
  }
  return null;
}
